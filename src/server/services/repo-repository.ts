import { DuckDBClient } from "../../shared/duckdb.js";
import { normalizeRepoPath } from "../../shared/utils/path.js";

/**
 * RepoRecord
 *
 * リポジトリレコードのデータ構造
 */
export interface RepoRecord {
  id: number;
  root: string;
}

/**
 * RepoRepository
 *
 * リポジトリテーブルへのデータアクセスを担当するクラス。
 * DB I/O のみを行い、ビジネスロジックは持たない。
 */
export class RepoRepository {
  constructor(private db: DuckDBClient) {}

  /**
   * normalized_root 列が存在するかチェックする。
   * 後方互換性のため、カラム存在チェックを行う。
   *
   * @returns カラムが存在する場合は true
   */
  private async hasNormalizedRootColumn(): Promise<boolean> {
    const cols = await this.db.all<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns()
       WHERE table_name = 'repo' AND column_name = 'normalized_root'`
    );
    return cols.length > 0;
  }

  /**
   * 指定されたパス候補のいずれかに一致するリポジトリを検索する。
   * Phase 1: normalized_root列を使用した高速検索をサポート。
   *
   * @param candidates - 検索するパス候補の配列
   * @returns 最初に見つかったリポジトリレコード、見つからない場合はnull
   */
  async findByPaths(candidates: string[]): Promise<RepoRecord | null> {
    if (candidates.length === 0) {
      return null;
    }

    // Step 1: Try direct root lookup first (legacy compatibility)
    const rootPlaceholders = candidates.map(() => "?").join(", ");
    let rows = await this.db.all<RepoRecord>(
      `SELECT id, root FROM repo WHERE root IN (${rootPlaceholders}) LIMIT 1`,
      candidates
    );

    if (rows.length > 0) {
      return rows[0] ?? null; // exactOptionalPropertyTypes 対応: undefined を null に変換
    }

    // Step 2: Try normalized_root lookup (fast path with index) if column exists
    const hasNormalizedRoot = await this.hasNormalizedRootColumn();
    if (hasNormalizedRoot) {
      const normalizedCandidates = candidates.map((c) => normalizeRepoPath(c));
      const normalizedPlaceholders = normalizedCandidates.map(() => "?").join(", ");
      rows = await this.db.all<RepoRecord>(
        `SELECT id, root FROM repo WHERE normalized_root IN (${normalizedPlaceholders}) LIMIT 1`,
        normalizedCandidates
      );

      return rows[0] ?? null; // exactOptionalPropertyTypes 対応: undefined を null に変換
    }

    return null;
  }

  /**
   * 正規化されたパスに一致するリポジトリを検索する（レガシーフォールバック）。
   * Phase 1: normalized_root 列が存在する場合、このメソッドは使用されなくなります。
   * マイグレーション期間中の安全性のため保持されています。
   *
   * NOTE: この処理は O(n) である。normalized_root カラム + インデックスが存在すれば不要。
   *
   * @param normalized - 正規化されたパス
   * @param normalizeFn - パスを正規化する関数
   * @returns 見つかったリポジトリレコード、見つからない場合はnull
   */
  async findByNormalizedPath(
    normalized: string,
    normalizeFn: (path: string) => string
  ): Promise<RepoRecord | null> {
    const allRepos = await this.db.all<RepoRecord>("SELECT id, root FROM repo");
    return allRepos.find((repo) => normalizeFn(repo.root) === normalized) || null;
  }

  /**
   * リポジトリのrootパスを更新する。
   *
   * @param id - リポジトリID
   * @param newRoot - 新しいrootパス
   */
  async updateRoot(id: number, newRoot: string): Promise<void> {
    await this.db.run("UPDATE repo SET root = ? WHERE id = ?", [newRoot, id]);
  }

  /**
   * repoテーブルが存在するかチェックする。
   *
   * @returns テーブルが存在する場合はtrue
   */
  async tableExists(): Promise<boolean> {
    try {
      await this.db.all("SELECT 1 FROM repo LIMIT 1");
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Table with name repo")) {
        return false;
      }
      throw new Error("Repo metadata check failed. Verify DuckDB permissions before retrying.");
    }
  }
}
