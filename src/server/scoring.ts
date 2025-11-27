import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSimpleYaml } from "../shared/utils/simpleYaml.js";

/**
 * スコアリングウェイトの設定
 * context_bundle の候補ファイルに対するスコアリング重みを定義
 */
export interface ScoringWeights {
  /** テキストマッチ（キーワード検索）の重み */
  textMatch: number;
  /** パスマッチ（ファイルパスにキーワードが含まれる）の重み */
  pathMatch: number;
  /** 編集中ファイル（editing_path）の重み */
  editingPath: number;
  /** 依存関係の重み */
  dependency: number;
  /** 近接ファイル（同一ディレクトリ）の重み */
  proximity: number;
  /** 構造的類似度の重み（LSHベース、セマンティック埋め込みではない） */
  structural: number;
  /** ドキュメントファイルへの乗算的ペナルティ（0.0-1.0、デフォルト: 0.5 = 50%削減） */
  docPenaltyMultiplier: number;
  /** 設定ファイルへの乗算的ペナルティ（0.0-1.0、デフォルト: 0.05 = 95%削減） */
  configPenaltyMultiplier: number;
  /** 実装ファイルへの乗算的ブースト（1.0以上、デフォルト: 1.3 = 30%ブースト） */
  implBoostMultiplier: number;
  /** ブラックリストディレクトリへの乗算的ペナルティ（0.0-1.0、デフォルト: 0.01 = 99%削減） */
  blacklistPenaltyMultiplier: number;
  /** テストファイルへの乗算的ペナルティ（0.0-1.0、デフォルト: 0.05 = 95%削減） */
  testPenaltyMultiplier: number;
  /** Lockファイルへの乗算的ペナルティ（0.0-1.0、デフォルト: 0.01 = 99%削減） */
  lockPenaltyMultiplier: number;

  // Graph Layer parameters (Phase 3.2)
  /** インバウンド依存関係ブースト（デフォルト: 0.5） */
  graphInbound: number;
  /** PageRank的重要度スコアの重み（デフォルト: 0.3） */
  graphImportance: number;
  /** 深度減衰係数（score / (depth + 1)^decay、デフォルト: 0.5） */
  graphDecay: number;
  /** BFS最大深度（デフォルト: 3） */
  graphMaxDepth: number;
  /** Co-changeブースト（Phase 4、デフォルト: 0.0 = 無効） */
  cochange: number;
}

export type ScoringProfileName =
  | "default"
  | "bugfix"
  | "testfail"
  | "typeerror"
  | "feature"
  | "debug"
  | "api"
  | "editor";

// プロファイルキャッシュ（起動時に一度だけロード）
let profilesCache: Record<ScoringProfileName, ScoringWeights> | null = null;

/**
 * スコアリングウェイトの妥当性を検証
 * すべてのウェイトが非負の有限数であることを確認
 */
function validateWeights(weights: unknown, profileName: string): ScoringWeights {
  if (typeof weights !== "object" || weights === null) {
    throw new Error(`Profile '${profileName}' must be an object`);
  }

  const required = [
    "textMatch",
    "pathMatch",
    "editingPath",
    "dependency",
    "proximity",
    "structural",
    "docPenaltyMultiplier",
    "configPenaltyMultiplier",
    "implBoostMultiplier",
    "blacklistPenaltyMultiplier",
    "testPenaltyMultiplier",
    "lockPenaltyMultiplier",
    // Graph Layer parameters (Phase 3.2)
    "graphInbound",
    "graphImportance",
    "graphDecay",
    "graphMaxDepth",
    "cochange",
  ];
  const obj = weights as Record<string, unknown>;

  // v1.0.0: Provide default values for new fields (backward compatibility)
  if (obj.blacklistPenaltyMultiplier === undefined) {
    console.warn(
      `[KIRI] Profile '${profileName}' missing blacklistPenaltyMultiplier, using default 0.01`
    );
    obj.blacklistPenaltyMultiplier = 0.01;
  }
  if (obj.testPenaltyMultiplier === undefined) {
    console.warn(
      `[KIRI] Profile '${profileName}' missing testPenaltyMultiplier, using default 0.02`
    );
    obj.testPenaltyMultiplier = 0.02;
  }
  if (obj.lockPenaltyMultiplier === undefined) {
    console.warn(
      `[KIRI] Profile '${profileName}' missing lockPenaltyMultiplier, using default 0.01`
    );
    obj.lockPenaltyMultiplier = 0.01;
  }

  // Graph Layer parameters (Phase 3.2): Provide default values for backward compatibility
  if (obj.graphInbound === undefined) {
    obj.graphInbound = 0.5;
  }
  if (obj.graphImportance === undefined) {
    obj.graphImportance = 0.3;
  }
  if (obj.graphDecay === undefined) {
    obj.graphDecay = 0.5;
  }
  if (obj.graphMaxDepth === undefined) {
    obj.graphMaxDepth = 3;
  }
  if (obj.cochange === undefined) {
    obj.cochange = 0.0;
  }

  for (const key of required) {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `Profile '${profileName}' has invalid ${key}: ${String(value)}. Must be a non-negative finite number.`
      );
    }
  }

  if ((obj.docPenaltyMultiplier as number) > 1) {
    throw new Error(
      `Profile '${profileName}' has docPenaltyMultiplier > 1 (${obj.docPenaltyMultiplier}). Penalties must be ≤ 1.`
    );
  }
  if ((obj.configPenaltyMultiplier as number) > 1) {
    throw new Error(
      `Profile '${profileName}' has configPenaltyMultiplier > 1 (${obj.configPenaltyMultiplier}). Penalties must be ≤ 1.`
    );
  }
  if ((obj.implBoostMultiplier as number) < 1) {
    throw new Error(
      `Profile '${profileName}' has implBoostMultiplier < 1 (${obj.implBoostMultiplier}). Boost multipliers must be ≥ 1.`
    );
  }
  if ((obj.blacklistPenaltyMultiplier as number) > 1) {
    throw new Error(
      `Profile '${profileName}' has blacklistPenaltyMultiplier > 1 (${obj.blacklistPenaltyMultiplier}). Penalties must be ≤ 1.`
    );
  }
  if ((obj.testPenaltyMultiplier as number) > 1) {
    throw new Error(
      `Profile '${profileName}' has testPenaltyMultiplier > 1 (${obj.testPenaltyMultiplier}). Penalties must be ≤ 1.`
    );
  }
  if ((obj.lockPenaltyMultiplier as number) > 1) {
    throw new Error(
      `Profile '${profileName}' has lockPenaltyMultiplier > 1 (${obj.lockPenaltyMultiplier}). Penalties must be ≤ 1.`
    );
  }

  const totalWeight =
    (obj.textMatch as number) +
    (obj.pathMatch as number) +
    (obj.editingPath as number) +
    (obj.dependency as number) +
    (obj.proximity as number) +
    (obj.structural as number);

  if (totalWeight < 2 || totalWeight > 15) {
    console.warn(
      `Profile '${profileName}' has unusual aggregate weight ${totalWeight.toFixed(2)}. Review weight balance if this was unintentional.`
    );
  }

  return weights as ScoringWeights;
}

function resolveScoringConfigPath(currentDir: string): string {
  const envPath = process.env.KIRI_SCORING_CONFIG;
  const candidates = [
    envPath,
    join(process.cwd(), "config/scoring-profiles.yml"),
    join(currentDir, "../../../config/scoring-profiles.yml"),
    join(currentDir, "../../../../config/scoring-profiles.yml"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Scoring profiles config not found. Checked paths: ${candidates.join(", ")}. ` +
      "Set KIRI_SCORING_CONFIG or place config/scoring-profiles.yml in the repo root."
  );
}

function loadProfilesFromConfig(): Record<ScoringProfileName, ScoringWeights> {
  if (profilesCache) {
    return profilesCache;
  }

  try {
    // 環境変数でカスタムパスを指定可能
    // 開発環境（src/）と本番環境（dist/src/）の両方で動作するようにdirname(__filename)から相対パス解決
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const configPath = resolveScoringConfigPath(__dirname);

    const configContent = readFileSync(configPath, "utf-8");
    const parsed = parseSimpleYaml(configContent) as unknown as Record<string, ScoringWeights>;

    // 必須プロファイルの検証とウェイトのバリデーション
    const requiredProfiles: ScoringProfileName[] = [
      "default",
      "bugfix",
      "testfail",
      "typeerror",
      "feature",
      "debug",
      "api",
      "editor",
    ];
    const validated: Record<string, ScoringWeights> = {};
    for (const profile of requiredProfiles) {
      if (!parsed[profile]) {
        throw new Error(`Missing required scoring profile: ${profile}`);
      }
      validated[profile] = validateWeights(parsed[profile], profile);
    }

    // 追加プロファイル（graph-off, graph-onなど）もロード
    for (const profileName of Object.keys(parsed)) {
      if (!validated[profileName]) {
        try {
          validated[profileName] = validateWeights(parsed[profileName], profileName);
        } catch (err) {
          console.warn(`[KIRI] Skipping invalid optional profile '${profileName}':`, err);
        }
      }
    }

    profilesCache = validated as Record<ScoringProfileName, ScoringWeights>;
    return profilesCache;
  } catch (error) {
    console.warn("Failed to load scoring profiles from config, using fallback defaults", error);
    // フォールバック: ハードコードされたデフォルト値
    profilesCache = {
      default: {
        textMatch: 1.0,
        pathMatch: 1.5,
        editingPath: 2.0,
        dependency: 0.5,
        proximity: 0.25,
        structural: 0.75,
        docPenaltyMultiplier: 0.5,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.3,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.02,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.5,
        graphImportance: 0.3,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
      debug: {
        textMatch: 1.0,
        pathMatch: 1.3,
        editingPath: 1.7,
        dependency: 1.2,
        proximity: 0.35,
        structural: 0.9,
        docPenaltyMultiplier: 0.5,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.45,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.02,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.55,
        graphImportance: 0.35,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
      api: {
        textMatch: 1.0,
        pathMatch: 1.5,
        editingPath: 1.8,
        dependency: 1.0,
        proximity: 0.3,
        structural: 0.95,
        docPenaltyMultiplier: 0.55,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.4,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.02,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.5,
        graphImportance: 0.3,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
      editor: {
        textMatch: 1.0,
        pathMatch: 1.4,
        editingPath: 1.9,
        dependency: 1.0,
        proximity: 0.4,
        structural: 0.9,
        docPenaltyMultiplier: 0.6,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.4,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.02,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.45,
        graphImportance: 0.25,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
      bugfix: {
        textMatch: 1.0,
        pathMatch: 1.5,
        editingPath: 1.8,
        dependency: 0.7,
        proximity: 0.35,
        structural: 0.9,
        docPenaltyMultiplier: 0.5,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.3,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.02,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.6,
        graphImportance: 0.4,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
      testfail: {
        textMatch: 1.0,
        pathMatch: 1.5,
        editingPath: 1.6,
        dependency: 0.85,
        proximity: 0.3,
        structural: 0.8,
        docPenaltyMultiplier: 0.5,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.3,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.2,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.4,
        graphImportance: 0.3,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
      typeerror: {
        textMatch: 1.0,
        pathMatch: 1.5,
        editingPath: 1.4,
        dependency: 0.6,
        proximity: 0.4,
        structural: 0.6,
        docPenaltyMultiplier: 0.5,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.3,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.02,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.35,
        graphImportance: 0.25,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
      feature: {
        textMatch: 1.0,
        pathMatch: 1.5,
        editingPath: 1.5,
        dependency: 0.45,
        proximity: 0.5,
        structural: 0.7,
        docPenaltyMultiplier: 0.5,
        configPenaltyMultiplier: 0.05,
        implBoostMultiplier: 1.3,
        blacklistPenaltyMultiplier: 0.01,
        testPenaltyMultiplier: 0.02,
        lockPenaltyMultiplier: 0.01,
        graphInbound: 0.5,
        graphImportance: 0.35,
        graphDecay: 0.5,
        graphMaxDepth: 3,
        cochange: 0.0,
      },
    };
    return profilesCache;
  }
}

export function coerceProfileName(name?: string | null): ScoringProfileName | null {
  if (!name) {
    return null;
  }
  const profiles = loadProfilesFromConfig();
  const normalized = name.toLowerCase() as ScoringProfileName;
  return normalized in profiles ? normalized : null;
}

export function loadScoringProfile(profileName?: ScoringProfileName | null): ScoringWeights {
  const profiles = loadProfilesFromConfig();

  if (profileName && profileName in profiles) {
    return profiles[profileName];
  }
  return profiles.default;
}
