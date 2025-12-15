import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseSimpleYaml } from "../../../shared/utils/simpleYaml.js";

export interface DenylistConfig {
  patterns: string[];
}

export interface DenylistFilter {
  isDenied(path: string): boolean;
  diff(): string[];
}

/**
 * Pattern classification type based on gitignore specification
 * - anywhere: no slash or trailing slash only or starts with ** - matches at any depth
 * - rooted: leading slash - matches only at root
 * - relative: intermediate slash - matches relative path
 */
type PatternType = "anywhere" | "rooted" | "relative";

interface PatternClassification {
  type: PatternType;
  hasTrailingSlash: boolean;
  normalizedPattern: string;
}

/**
 * Classify pattern based on gitignore specification
 *
 * Gitignore rules:
 * - No slash: matches at any depth (e.g., node_modules, *.log)
 * - Trailing slash only: matches directory at any depth (e.g., node_modules/)
 * - Leading slash: matches only at root (e.g., /node_modules/)
 * - Intermediate slash: matches relative path (e.g., src/generated/)
 *
 * @param pattern Glob pattern string
 * @returns Pattern classification result
 */
function classifyPattern(pattern: string): PatternClassification {
  const hasTrailingSlash = pattern.endsWith("/");
  const trimmed = hasTrailingSlash ? pattern.slice(0, -1) : pattern;

  // 先頭スラッシュあり: ルート相対
  if (trimmed.startsWith("/")) {
    return {
      type: "rooted",
      hasTrailingSlash,
      normalizedPattern: trimmed.slice(1),
    };
  }

  // Intermediate slash: relative path (gitignore spec)
  // Patterns starting with **/ are treated as "anywhere" type
  if (trimmed.includes("/") && !trimmed.startsWith("**/")) {
    return {
      type: "relative",
      hasTrailingSlash,
      normalizedPattern: trimmed,
    };
  }

  // No slash, or starts with **/: matches at any depth
  // For **/ prefix patterns, strip the **/ and let the "anywhere" prefix handle depth
  const strippedPattern = trimmed.startsWith("**/") ? trimmed.slice(3) : trimmed;

  return {
    type: "anywhere",
    hasTrailingSlash,
    normalizedPattern: strippedPattern,
  };
}

/**
 * Globパターンを正規表現に変換（ReDoS対策済み、gitignore仕様準拠）
 *
 * gitignore仕様:
 * - スラッシュなし/末尾スラッシュのみ: 任意の深さでマッチ
 *   例: node_modules/ → ルートでもサブディレクトリでもマッチ
 * - 先頭スラッシュあり: ルートのみマッチ
 *   例: /node_modules/ → ルート直下のみ
 * - 中間スラッシュあり: 相対パスとして解釈
 *   例: src/generated/ → src/generated/ にのみマッチ
 * - 末尾スラッシュ: ディレクトリのみマッチ（サブパスも含む）
 *
 * @param pattern Globパターン文字列
 * @returns コンパイル済み正規表現
 * @throws パターンが長すぎる、または複雑すぎる場合
 */
function toRegex(pattern: string): RegExp {
  // ReDoS対策: パターン長の制限
  if (pattern.length > 500) {
    throw new Error("Denylist pattern exceeds maximum length. Simplify the pattern.");
  }

  const { type, hasTrailingSlash, normalizedPattern } = classifyPattern(pattern);

  // 正規表現用にエスケープ（**は後で処理するためプレースホルダに）
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::");

  // Convert wildcards to regex
  // IMPORTANT: Replace single * before doublestar placeholder
  // to avoid .* having its * replaced with [^/]*
  const withWildcards = escaped
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*")
    .replace(/\?/g, ".");

  // ディレクトリの場合のサフィックス（サブパスにもマッチ）
  const suffix = hasTrailingSlash ? "(?:/.*)?" : "";

  // パターンタイプに応じてプレフィックス決定
  // - anywhere: 任意の深さでマッチ（先頭または任意のディレクトリ境界から）
  // - rooted/relative: ルートからのみマッチ
  const prefix = type === "anywhere" ? "(?:^|.*/)" : "^";

  const finalPattern = `${prefix}${withWildcards}${suffix}$`;

  // ReDoS対策: 最終パターンの複雑度チェック（ネストした量指定子）
  // [^/]* は bounded なので安全、.* のみを危険なパターンとしてカウント
  // [^/]* を除去してから危険な量指定子をチェック
  const withoutBounded = finalPattern.replace(/\[\^\/\]\*/g, "");
  if (/(\.\*|\w\+|\{\d+,\}).*(\.\*|\w\+|\{\d+,\}).*(\.\*|\w\+|\{\d+,\})/.test(withoutBounded)) {
    throw new Error("Denylist pattern is too complex. Use simpler glob patterns.");
  }

  return new RegExp(finalPattern);
}

function loadGitignore(repoRoot: string): string[] {
  try {
    const raw = readFileSync(resolve(repoRoot, ".gitignore"), "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * denylist.ymlを読み込む
 * ファイルが存在しない場合は空のパターン配列を返す（.gitignoreのみで動作可能にする）
 * ファイルが存在するが内容が無効な場合はエラーを投げる（設定ミスを検出可能にする）
 */
export function loadDenylistConfig(configPath?: string): DenylistConfig {
  const path = resolve(configPath ?? "config/denylist.yml");

  // ファイルが存在しない場合は空のパターンを返す
  if (!existsSync(path)) {
    return { patterns: [] };
  }

  const content = readFileSync(path, "utf8");
  const parsed = parseSimpleYaml(content) as Record<string, unknown>;
  const patterns = Array.isArray(parsed.patterns)
    ? parsed.patterns.filter((value): value is string => typeof value === "string")
    : [];

  // ファイルが存在する場合、有効なパターンが必要
  // （設定ミスを静かに無視しないため）
  if (patterns.length === 0) {
    throw new Error(
      `${path} exists but contains no valid patterns. ` +
        "Add patterns array or remove the file to use .gitignore only."
    );
  }

  return { patterns };
}

export function createDenylistFilter(repoRoot: string, configPath?: string): DenylistFilter {
  const { patterns } = loadDenylistConfig(configPath);
  const gitignorePatterns = loadGitignore(repoRoot);
  const combined = Array.from(new Set([...patterns, ...gitignorePatterns]));
  const regexList = combined.map(toRegex);
  const diffEntries = gitignorePatterns.filter((pattern) => !patterns.includes(pattern));

  return {
    isDenied(path: string) {
      const normalized = path.startsWith("/") ? path.slice(1) : path;
      return regexList.some((regex) => regex.test(normalized));
    },
    diff() {
      return diffEntries;
    },
  };
}
