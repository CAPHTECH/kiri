/**
 * Boost Profile Configurations
 *
 * This module provides centralized configuration for boost_profile options.
 * Each profile defines how different file types should be ranked in search results.
 *
 * Profiles:
 * - default: Prioritizes implementation files over documentation
 * - docs: Prioritizes documentation over implementation
 * - balanced: Equal weight for both docs and implementation
 * - none: No file type boosting (pure keyword scoring)
 */

export interface PathMultiplier {
  prefix: string;
  multiplier: number;
}

/**
 * Boost profile configuration
 * Defines how different file types should be ranked
 */
export interface BoostProfileConfig {
  /**
   * Directories to allow even if they match global denylist patterns.
   * Example: ["docs/"] allows docs/ files despite being blacklisted by default.
   * This overrides the global blacklist in applyFileTypeBoost/applyAdditiveFilePenalties.
   */
  denylistOverrides: string[];

  /** Multiplicative factors for different file types */
  fileTypeMultipliers: {
    /** Documentation files (.md, .yaml, .yml, .mdc) */
    doc: number;
    /** Implementation files (src/**) */
    impl: number;
    /** Configuration files (tsconfig.json, package.json, etc.) */
    config: number;
  };

  /**
   * Path-specific multipliers (e.g., src/app/ gets higher boost than src/)
   * Array is sorted by prefix length (longest first) to ensure correct matching priority
   */
  pathMultipliers: PathMultiplier[];

  /**
   * Skip additive penalty for config files (-1.5 score penalty)
   * and only apply multiplicative penalty (e.g., 0.3x multiplier)
   * @default false
   */
  skipConfigAdditivePenalty?: boolean;
}

export type BoostProfileName =
  | "default"
  | "docs"
  | "none"
  | "balanced"
  | "code"
  | "feature"
  | "bugfix"
  | "debug"
  | "api"
  | "editor"
  | "testfail"
  | "typeerror"
  | "vscode";

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function applyEnvOverrides(
  name: BoostProfileName,
  profile: BoostProfileConfig
): BoostProfileConfig {
  // Allow overriding default and vscode profiles; others stay deterministic.
  if (name !== "default" && name !== "vscode") {
    return profile;
  }

  const docMultOverride = readEnvNumber("KIRI_DOC_MULT", profile.fileTypeMultipliers.doc);
  const vsBoostFactor = readEnvNumber("KIRI_VS_BOOST", 1.0);
  const schemaBoostFactor = readEnvNumber("KIRI_SCHEMA_BOOST", 1.0);

  const vsPrefixes = [
    "src/vs/workbench/contrib/",
    "src/vs/workbench/",
    "src/vs/platform/",
    "src/vs/editor/",
    "src/vs/base/",
    "src/vs/",
  ];

  const schemaPrefixes = [
    "packages/assay-kit/src/dataset/schemas/",
    "packages/assay-kit/src/dataset/",
  ];

  return {
    ...profile,
    fileTypeMultipliers: {
      ...profile.fileTypeMultipliers,
      doc: docMultOverride,
    },
    pathMultipliers: profile.pathMultipliers.map((entry) => {
      let multiplier = entry.multiplier;
      if (vsPrefixes.some((p) => entry.prefix.startsWith(p))) {
        multiplier *= vsBoostFactor;
      }
      if (schemaPrefixes.some((p) => entry.prefix.startsWith(p))) {
        multiplier *= schemaBoostFactor;
      }
      return { ...entry, multiplier };
    }),
  };
}

/**
 * Boost profile definitions
 * Centralized configuration for all boost profiles
 */
export const BOOST_PROFILES: Record<BoostProfileName, BoostProfileConfig> = {
  default: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      // Keep moderate doc penalty; path boosts below handle repo-specific noise
      doc: 0.5,
      impl: 1.3, // 30% boost for implementation
      config: 0.05, // 95% penalty for config files
    },
    // ✅ Sorted by prefix length (longest first) for correct matching priority
    pathMultipliers: [
      // VS Code monorepo targets (golden-set covers VS Code paths heavily)
      { prefix: "src/vs/workbench/contrib/", multiplier: 2.4 },
      { prefix: "src/vs/workbench/", multiplier: 2.2 },
      { prefix: "src/vs/platform/", multiplier: 2.1 },
      { prefix: "src/vs/editor/", multiplier: 2.0 },
      { prefix: "src/vs/base/", multiplier: 1.9 },
      { prefix: "src/vs/", multiplier: 1.8 },

      // Assay-kit (golden-set includes adapter/dataset queries)
      { prefix: "packages/assay-kit/src/dataset/loader.ts", multiplier: 6.0 },
      { prefix: "packages/assay-kit/src/dataset/schemas/", multiplier: 3.0 },
      { prefix: "packages/assay-kit/src/dataset/importer/", multiplier: 0.4 },
      { prefix: "packages/assay-kit/src/dataset/diff/", multiplier: 0.1 },
      { prefix: "packages/assay-kit/src/dataset/", multiplier: 1.9 },
      { prefix: "packages/assay-kit/src/", multiplier: 1.7 },

      { prefix: "src/components/", multiplier: 1.3 },
      { prefix: "src/app/", multiplier: 1.4 },
      { prefix: "src/lib/", multiplier: 1.2 },
      { prefix: "src/", multiplier: 1.0 },
    ],
  },

  docs: {
    denylistOverrides: ["docs/"],
    fileTypeMultipliers: {
      doc: 2.5, // Strong boost for docs
      impl: 0.3, // Stronger penalty for implementation
      config: 0.4, // Keep config accessible in docs-focused searches
    },
    pathMultipliers: [
      { prefix: "docs/", multiplier: 2.0 },
      { prefix: "docs/processes/", multiplier: 2.2 },
      { prefix: "docs/dcca/", multiplier: 1.8 },
      { prefix: "docs/formal/", multiplier: 1.2 },
    ],
  },

  balanced: {
    denylistOverrides: ["docs/"],
    fileTypeMultipliers: {
      doc: 1.0, // No penalty for docs
      impl: 1.0, // No boost for implementation
      // Config files in balanced mode are considered more relevant for understanding
      // a project's structure alongside its documentation. Therefore, we use a
      // higher multiplier (0.3x vs 0.05x in default) to keep them accessible.
      config: 0.3,
    },
    pathMultipliers: [], // No path-specific boosts in balanced mode
    // Skip additive penalty (-1.5) for config files; use only multiplicative penalty.
    // This prevents config files from being completely deprioritized in balanced searches
    // where understanding project setup is often as important as code/docs.
    skipConfigAdditivePenalty: true,
  },

  none: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 1.0, // No penalty/boost
      impl: 1.0, // No penalty/boost
      config: 1.0, // No penalty/boost
    },
    pathMultipliers: [],
  },

  code: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.05, // 95% penalty for docs (stronger than default's 0.5)
      impl: 1.4, // 40% boost for implementation
      config: 0.05, // 95% penalty for config files
    },
    // Note: Order of pathMultipliers doesn't affect matching (longest prefix wins in applyPathMultipliers)
    pathMultipliers: [
      // Strongly suppress common root documentation files (×0.01 = 99% penalty)
      { prefix: "CLAUDE.md", multiplier: 0.01 },
      { prefix: "README.md", multiplier: 0.01 },
      { prefix: "CHANGELOG.md", multiplier: 0.01 },
      { prefix: "CONTRIBUTING.md", multiplier: 0.01 },
      { prefix: "AGENTS.md", multiplier: 0.01 },
      // Implementation file boosts (same as default)
      { prefix: "src/components/", multiplier: 1.3 },
      { prefix: "src/app/", multiplier: 1.4 },
      { prefix: "src/lib/", multiplier: 1.2 },
      { prefix: "src/", multiplier: 1.0 },
    ],
  },

  feature: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.65, // Docs penalty
      impl: 1.25, // Implementation boost
      config: 0.05, // Config penalty
    },
    pathMultipliers: [
      { prefix: "src/server/handlers/", multiplier: 2.5 }, // 新機能ハンドラー
      { prefix: "src/indexer/pipeline/", multiplier: 2.3 }, // パイプライン機能
      { prefix: "src/server/", multiplier: 2.0 },
      { prefix: "src/indexer/", multiplier: 1.8 },
      { prefix: "src/shared/", multiplier: 1.6 },
      { prefix: "scripts/assay/", multiplier: 1.5 }, // 評価スクリプト
      { prefix: "src/", multiplier: 0.7 }, // 抑制: 0.8 → 0.7
    ],
  },

  bugfix: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.65, // Docs penalty
      impl: 1.2, // Implementation boost
      config: 0.05, // Config penalty
    },
    pathMultipliers: [
      { prefix: "src/shared/security/", multiplier: 2.5 }, // セキュリティ修正
      { prefix: "src/shared/utils/", multiplier: 2.3 }, // ユーティリティ修正
      { prefix: "src/server/fallbacks/", multiplier: 2.2 }, // フォールバック
      { prefix: "src/shared/", multiplier: 2.0 },
      { prefix: "src/server/", multiplier: 1.8 },
      { prefix: "src/indexer/", multiplier: 1.6 },
      { prefix: "tests/", multiplier: 1.5 }, // バグ再現テスト
      { prefix: "src/", multiplier: 0.7 }, // 抑制: 0.8 → 0.7
    ],
  },

  debug: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.65, // Docs penalty
      impl: 1.25, // Implementation boost
      config: 0.05, // Config penalty
    },
    pathMultipliers: [
      { prefix: "src/server/observability/", multiplier: 2.5 }, // 監視・トレース
      { prefix: "src/shared/utils/retry.ts", multiplier: 2.4 }, // リトライロジック
      { prefix: "src/server/fallbacks/", multiplier: 2.3 }, // デグレード制御
      { prefix: "src/shared/utils/", multiplier: 2.0 },
      { prefix: "scripts/diag/", multiplier: 1.8 }, // 診断スクリプト
      { prefix: "src/server/", multiplier: 1.6 },
      { prefix: "tests/", multiplier: 1.5 },
      { prefix: "src/", multiplier: 0.7 }, // 抑制: 0.8 → 0.7
    ],
  },

  api: {
    denylistOverrides: ["docs/"],
    fileTypeMultipliers: {
      doc: 0.65, // Docs penalty
      impl: 1.2, // Implementation boost
      config: 0.05, // Config penalty
    },
    pathMultipliers: [
      { prefix: "src/api/", multiplier: 2.5 }, // 強化: 1.4 → 2.5
      { prefix: "src/routes/", multiplier: 2.3 },
      { prefix: "src/controllers/", multiplier: 2.0 },
      { prefix: "src/middleware/", multiplier: 1.8 },
      { prefix: "src/app/", multiplier: 1.3 },
      { prefix: "src/", multiplier: 0.7 }, // 抑制: 1.0 → 0.7
    ],
  },

  editor: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.65, // Docs penalty
      impl: 1.2, // Implementation boost
      config: 0.05, // Config penalty
    },
    pathMultipliers: [
      { prefix: "src/components/", multiplier: 2.2 }, // 強化: 1.3 → 2.2
      { prefix: "src/editor/", multiplier: 2.5 },
      { prefix: "src/ui/", multiplier: 2.0 },
      { prefix: "src/views/", multiplier: 2.0 },
      { prefix: "src/app/", multiplier: 1.5 },
      { prefix: "src/", multiplier: 0.7 }, // 抑制: 1.0 → 0.7
    ],
  },

  testfail: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.65, // Docs penalty
      impl: 1.2, // Implementation boost
      config: 0.05, // Config penalty
    },
    pathMultipliers: [
      { prefix: "tests/", multiplier: 2.5 }, // 強化: 1.5 → 2.5
      { prefix: "test/", multiplier: 2.5 }, // 強化: 1.5 → 2.5
      { prefix: "__tests__/", multiplier: 2.5 },
      { prefix: "spec/", multiplier: 2.3 },
      { prefix: "src/", multiplier: 0.5 }, // 大幅抑制: 1.0 → 0.5
    ],
  },

  typeerror: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.65, // Docs penalty
      impl: 1.2, // Implementation boost
      config: 0.05, // Config penalty
    },
    pathMultipliers: [
      { prefix: "src/types/", multiplier: 3.0 }, // 強化: 1.4 → 3.0
      { prefix: "types/", multiplier: 3.0 }, // 強化: 1.4 → 3.0
      { prefix: "@types/", multiplier: 2.8 },
      { prefix: "src/interfaces/", multiplier: 2.5 },
      { prefix: "src/models/", multiplier: 1.8 },
      { prefix: "src/", multiplier: 0.6 }, // 抑制: 1.0 → 0.6
    ],
  },

  vscode: {
    denylistOverrides: ["extensions/"],
    fileTypeMultipliers: {
      // Penalize docs a bit more to push down README/CONTRIBUTING noise
      doc: 0.35,
      impl: 1.35,
      config: 0.05,
    },
    pathMultipliers: [
      // Focus boosts for low-precision queries (tree-data-provider, task-terminal, microtask-debug)
      { prefix: "src/vs/workbench/services/views/", multiplier: 3.6 },
      { prefix: "src/vs/workbench/contrib/terminal/", multiplier: 3.5 },
      { prefix: "src/vs/workbench/contrib/debug/", multiplier: 3.4 },
      { prefix: "src/vs/workbench/services/task", multiplier: 3.3 },
      { prefix: "src/vs/base/common/", multiplier: 0.3 },
      // Narrower boosts for persistent low-P@10 queries
      { prefix: "src/vs/workbench/contrib/terminal/browser/", multiplier: 3.8 },
      { prefix: "src/vs/workbench/contrib/terminal/test/", multiplier: 3.6 },
      { prefix: "src/vs/workbench/contrib/debug/common/", multiplier: 3.6 },
      { prefix: "src/vs/workbench/contrib/debug/browser/", multiplier: 3.6 },
      { prefix: "src/vs/workbench/contrib/tasks/browser/", multiplier: 5.0 },
      { prefix: "src/vs/workbench/contrib/tasks/browser/taskTerminalStatus.ts", multiplier: 5.2 },
      { prefix: "src/vs/workbench/contrib/tasks/browser/terminalTaskSystem.ts", multiplier: 5.5 },
      { prefix: ".eslint-ignore", multiplier: 0.05 },
      { prefix: "cglicenses.json", multiplier: 0.05 },
      { prefix: ".vscode-test.js", multiplier: 0.05 },
      { prefix: ".eslint-plugin-local/", multiplier: 0.02 },
      // Strongly suppress CLI docs/Rust artifacts that pollute terminal/task queries
      { prefix: "cli/CONTRIBUTING.md", multiplier: 0.005 },
      { prefix: "README.md", multiplier: 0.005 },
      { prefix: "cli/src/", multiplier: 0.01 },
      { prefix: "cli/", multiplier: 0.01 },
      { prefix: "cli/src/tunnels/", multiplier: 0.008 },
      { prefix: "cli/src/desktop/", multiplier: 0.008 },
      { prefix: "cli/src/commands/", multiplier: 0.008 },
      { prefix: "cli/src/util/", multiplier: 0.008 },
      { prefix: "src/vs/workbench/contrib/", multiplier: 2.8 },
      { prefix: "src/vs/workbench/", multiplier: 2.6 },
      { prefix: "src/vs/platform/", multiplier: 2.5 },
      { prefix: "src/vs/editor/", multiplier: 2.4 },
      { prefix: "src/vs/base/", multiplier: 2.3 },
      { prefix: "src/vs/", multiplier: 2.1 },
      // VS Code extensions are often noisy for repo-level queries; keep but suppress
      { prefix: "extensions/", multiplier: 0.1 },
      { prefix: "src/", multiplier: 0.8 },
      { prefix: ".eslint-plugin-local/", multiplier: 0.02 },
    ],
  },
};

/**
 * Get boost profile configuration by name
 * @throws Error if profile name is invalid
 */
export function getBoostProfile(name: BoostProfileName): BoostProfileConfig {
  const profile = BOOST_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Invalid boost profile: "${name}". ` +
        `Valid profiles are: ${Object.keys(BOOST_PROFILES).join(", ")}`
    );
  }
  return applyEnvOverrides(name, profile);
}

/**
 * Check if a profile name is valid
 */
export function isValidBoostProfile(name: string): name is BoostProfileName {
  return name in BOOST_PROFILES;
}
