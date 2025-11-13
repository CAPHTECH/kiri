import { DuckDBClient } from "../../shared/duckdb.js";

import { RepoRepository } from "./repo-repository.js";
import { RepoResolver } from "./repo-resolver.js";

/**
 * ServerServices
 *
 * サーバー全体で共有されるサービスの集合。
 * リクエスト間で共有され、単一のインスタンスを持つ。
 */
export interface ServerServices {
  repoRepository: RepoRepository;
  repoResolver: RepoResolver;
}

/**
 * createServerServices
 *
 * サーバーサービスを初期化して返す。
 * サーバー起動時に一度だけ呼び出される。
 *
 * @param db - DuckDBクライアント
 * @returns 初期化されたサービス群
 */
export function createServerServices(db: DuckDBClient): ServerServices {
  const repoRepository = new RepoRepository(db);
  const repoResolver = new RepoResolver(repoRepository);

  return {
    repoRepository,
    repoResolver,
  };
}
