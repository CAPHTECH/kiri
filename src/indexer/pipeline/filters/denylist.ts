import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import ignore, { type Ignore } from "ignore";

import { parseSimpleYaml } from "../../../shared/utils/simpleYaml.js";

export interface DenylistConfig {
  patterns: string[];
}

export interface DenylistFilter {
  isDenied(path: string): boolean;
  diff(): string[];
}

/**
 * .gitignore ファイルを読み込んでパターン配列を返す
 * ファイルが存在しない場合は空配列を返す
 */
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
 * denylist.yml を読み込む
 * ファイルが存在しない場合は空のパターン配列を返す（.gitignore のみで動作可能にする）
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

// Validate patterns and throw error for overly broad or negation patterns.
// Overly broad patterns match all files and are likely configuration mistakes.
// Negation patterns are forbidden in denylist for security (denylist must always deny).
function validatePatterns(patterns: string[]): void {
  const overlyBroadPatterns = new Set(["", "**", "**/", "/"]);
  for (const pattern of patterns) {
    if (overlyBroadPatterns.has(pattern)) {
      throw new Error(
        `Overly broad denylist pattern: "${pattern}". ` +
          "Use a more specific pattern or remove this entry."
      );
    }
    // 否定パターンはdenylistでは禁止（セキュリティ上の理由）
    if (pattern.startsWith("!")) {
      throw new Error(
        `Negation pattern in denylist: "${pattern}". ` +
          "Denylist patterns must always deny; negation is not allowed."
      );
    }
  }
}

/**
 * denylist フィルターを作成する
 *
 * `ignore` ライブラリ (node-ignore) を使用して gitignore 互換のフィルタリングを行う。
 * 注意: ルートの .gitignore のみ読み込む簡易ローダ実装。
 *
 * gitignore 互換の動作:
 * - ディレクトリにマッチした場合、その配下のファイルも自動的に除外
 * - 先頭スラッシュ（/node_modules）はルート直下のみマッチ
 * - スラッシュなし（node_modules）は任意の深さでマッチ
 *
 * セキュリティ: denylist.yml のパターンは .gitignore より優先される（後から適用）。
 * denylist.yml では否定パターン（!pattern）は禁止。
 *
 * @param repoRoot リポジトリルートの絶対パス
 * @param configPath オプションの denylist.yml パス
 * @returns DenylistFilter インターフェース
 */
export function createDenylistFilter(repoRoot: string, configPath?: string): DenylistFilter {
  const { patterns } = loadDenylistConfig(configPath);

  // denylist.yml のパターンのみバリデーション（.gitignore はユーザーコントロール外の可能性があるため）
  validatePatterns(patterns);
  const gitignorePatterns = loadGitignore(repoRoot);

  // diff() 用: .gitignore にあって denylist.yml にないパターン
  const patternSet = new Set(patterns);
  const diffEntries = gitignorePatterns.filter((pattern) => !patternSet.has(pattern));

  // ignore インスタンスを作成
  // 重要: gitignore を先に追加し、denylist を後に追加することで denylist が優先される
  // （ignore ライブラリは「後勝ち」セマンティクス）
  const ig: Ignore = ignore().add(gitignorePatterns).add(patterns);

  return {
    /**
     * 指定されたパスが除外対象かどうかを判定
     * @param path リポジトリルートからの相対パス
     * @returns 除外対象の場合 true
     */
    isDenied(path: string) {
      // ignore ライブラリは先頭スラッシュなしのパスを期待する
      const normalized = path.startsWith("/") ? path.slice(1) : path;

      // 空パスはルートディレクトリ自体を表すので除外しない
      if (normalized === "") {
        return false;
      }

      return ig.ignores(normalized);
    },

    /**
     * .gitignore に含まれていて denylist.yml に含まれていないパターンを返す
     * デバッグや差分確認用
     */
    diff() {
      return diffEntries;
    },
  };
}
