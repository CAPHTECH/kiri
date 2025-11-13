import { DuckDBClient } from "../shared/duckdb.js";

import { WarningManager } from "./rpc.js";
import { ServerServices } from "./services/index.js";

export interface FtsStatusCache {
  ready: boolean;
  schemaExists: boolean;
  anyDirty: boolean;
  lastChecked: number;
}

export interface ServerContext {
  db: DuckDBClient;
  repoId: number;
  services: ServerServices;
  features?: {
    fts?: boolean; // FTS拡張が利用可能かどうか
  };
  ftsStatusCache?: FtsStatusCache;
  warningManager: WarningManager;
}

/**
 * createServerContext
 *
 * ServerContext を生成するファクトリ関数。
 * テストや複数のエントリポイントで共通の初期化パスを提供する。
 *
 * @param options - コンテキスト初期化オプション
 * @returns 初期化された ServerContext
 */
export function createServerContext(options: {
  db: DuckDBClient;
  repoId: number;
  services: ServerServices;
  features?: { fts?: boolean };
  ftsStatusCache?: FtsStatusCache;
  warningManager: WarningManager;
}): ServerContext {
  const context: ServerContext = {
    db: options.db,
    repoId: options.repoId,
    services: options.services,
    warningManager: options.warningManager,
  };

  // exactOptionalPropertyTypes: true を満たすため、undefined の場合は代入しない
  if (options.features !== undefined) {
    context.features = options.features;
  }

  if (options.ftsStatusCache !== undefined) {
    context.ftsStatusCache = options.ftsStatusCache;
  }

  return context;
}
