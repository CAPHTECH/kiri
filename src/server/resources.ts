/**
 * MCP Resources機能のためのリソースプロバイダー
 *
 * MCP仕様: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { DuckDBClient } from "../shared/duckdb.js";

// =============================================================================
// 型定義
// =============================================================================

/**
 * リソース記述子（resources/listで返す形式）
 */
export interface ResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * リソースコンテンツ（resources/readで返す形式）
 */
export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * resources/readのレスポンス
 */
export interface ResourceReadResult {
  contents: ResourceContent[];
}

/**
 * プロジェクト統計情報
 */
interface ProjectStats {
  totalFiles: number;
  totalLines: number;
  languages: Record<string, number>;
  lastIndexed: string | null;
}

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * ファイルが存在するかチェック
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * プロジェクト統計を取得
 */
async function getProjectStats(db: DuckDBClient, repoId: number): Promise<ProjectStats> {
  // ファイル数と行数を取得（blobテーブルと結合してline_countを取得）
  const fileStats = await db.all<{ total_files: number; total_lines: number }>(
    `SELECT
      COUNT(*) as total_files,
      COALESCE(SUM(b.line_count), 0) as total_lines
    FROM file f
    LEFT JOIN blob b ON f.blob_hash = b.hash
    WHERE f.repo_id = ?`,
    [repoId]
  );

  // 言語別ファイル数を取得
  const langStats = await db.all<{ lang: string; count: number }>(
    `SELECT
      COALESCE(lang, 'unknown') as lang,
      COUNT(*) as count
    FROM file
    WHERE repo_id = ?
    GROUP BY lang
    ORDER BY count DESC
    LIMIT 20`,
    [repoId]
  );

  // 最終インデックス日時を取得
  const indexInfo = await db.all<{ indexed_at: string }>(
    `SELECT indexed_at FROM repo WHERE id = ?`,
    [repoId]
  );

  const languages: Record<string, number> = {};
  for (const row of langStats) {
    languages[row.lang] = row.count;
  }

  return {
    totalFiles: fileStats[0]?.total_files ?? 0,
    totalLines: fileStats[0]?.total_lines ?? 0,
    languages,
    lastIndexed: indexInfo[0]?.indexed_at ?? null,
  };
}

// =============================================================================
// リソース一覧
// =============================================================================

/**
 * 利用可能なリソース一覧を取得
 *
 * @param repoRoot - リポジトリのルートパス
 * @returns リソース記述子の配列
 */
export async function listResources(repoRoot: string): Promise<ResourceDescriptor[]> {
  const resources: ResourceDescriptor[] = [];

  // CLAUDE.md
  const claudeMdPath = path.join(repoRoot, "CLAUDE.md");
  if (await fileExists(claudeMdPath)) {
    resources.push({
      uri: "kiri://project/claude-md",
      name: "CLAUDE.md",
      description: "プロジェクト固有のAI指示",
      mimeType: "text/markdown",
    });
  }

  // README.md
  const readmePath = path.join(repoRoot, "README.md");
  if (await fileExists(readmePath)) {
    resources.push({
      uri: "kiri://project/readme",
      name: "README.md",
      description: "プロジェクト概要",
      mimeType: "text/markdown",
    });
  }

  // プロジェクト統計（常に利用可能）
  resources.push({
    uri: "kiri://project/stats",
    name: "プロジェクト統計",
    description: "ファイル数、言語分布等",
    mimeType: "application/json",
  });

  return resources;
}

// =============================================================================
// リソース読み取り
// =============================================================================

/**
 * リソースの内容を読み取る
 *
 * @param uri - リソースURI
 * @param repoRoot - リポジトリのルートパス
 * @param db - DuckDBクライアント
 * @param repoId - リポジトリID
 * @returns リソースコンテンツの配列
 * @throws Error - リソースが見つからない場合
 */
export async function readResource(
  uri: string,
  repoRoot: string,
  db: DuckDBClient,
  repoId: number
): Promise<ResourceReadResult> {
  switch (uri) {
    case "kiri://project/claude-md": {
      const filePath = path.join(repoRoot, "CLAUDE.md");
      if (!(await fileExists(filePath))) {
        throw new Error(`Resource not found: ${uri}. CLAUDE.md does not exist in project root.`);
      }
      const text = await readFile(filePath, "utf-8");
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text,
          },
        ],
      };
    }

    case "kiri://project/readme": {
      const filePath = path.join(repoRoot, "README.md");
      if (!(await fileExists(filePath))) {
        throw new Error(`Resource not found: ${uri}. README.md does not exist in project root.`);
      }
      const text = await readFile(filePath, "utf-8");
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text,
          },
        ],
      };
    }

    case "kiri://project/stats": {
      const stats = await getProjectStats(db, repoId);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown resource: ${uri}. Use resources/list to see available resources.`);
  }
}
