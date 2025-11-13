import { getRepoPathCandidates, normalizeRepoPath } from "../../shared/utils/path.js";
import { RepoRepository } from "./repo-repository.js";

/**
 * RepoNotFoundError
 *
 * リポジトリが見つからなかった場合のエラー
 */
export class RepoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoNotFoundError";
  }
}

/**
 * RepoResolver
 *
 * リポジトリパスをデータベースIDに解決する責務を持つクラス。
 * パス正規化とDB検索を組み合わせ、エラー処理も担当する。
 */
export class RepoResolver {
  constructor(private repository: RepoRepository) {}

  /**
   * リポジトリのrootパスをデータベースIDに解決する。
   *
   * @param repoRoot - リポジトリのrootパス
   * @returns リポジトリID
   * @throws RepoNotFoundError リポジトリがインデックスされていない場合
   */
  async resolveId(repoRoot: string): Promise<number> {
    // repoテーブルの存在確認
    const tableExists = await this.repository.tableExists();
    if (!tableExists) {
      throw new RepoNotFoundError(
        `Repository ${repoRoot} was not indexed. Run the indexer before starting the server.`
      );
    }

    // パス候補と正規化パスを取得
    const candidates = getRepoPathCandidates(repoRoot);
    const normalized = candidates[0];

    // exactOptionalPropertyTypes 対応: candidates[0] が undefined の場合はエラー
    if (!normalized) {
      throw new RepoNotFoundError(
        `Repository ${repoRoot} path normalization failed. Check path validity.`
      );
    }

    // 高速パス: 直接検索を試みる
    let repo = await this.repository.findByPaths(candidates);

    // 低速パス: 正規化フォールバックを試みる
    if (!repo) {
      repo = await this.repository.findByNormalizedPath(normalized, normalizeRepoPath);

      if (!repo) {
        throw new RepoNotFoundError(
          `Repository ${repoRoot} was not indexed. Run the indexer before starting the server.`
        );
      }

      // 次回の高速検索のために正規化パスに更新
      await this.repository.updateRoot(repo.id, normalized);
    }

    // パスが正規化されていない場合は更新
    if (repo.root !== normalized) {
      await this.repository.updateRoot(repo.id, normalized);
    }

    return repo.id;
  }
}
