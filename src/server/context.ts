import { DuckDBClient } from "../shared/duckdb.js";

import { WarningManager } from "./rpc.js";

export interface FtsStatusCache {
  ready: boolean;
  schemaExists: boolean;
  anyDirty: boolean;
  lastChecked: number;
}

export interface ServerContext {
  db: DuckDBClient;
  repoId: number;
  features?: {
    fts?: boolean; // FTS拡張が利用可能かどうか
  };
  ftsStatusCache?: FtsStatusCache;
  warningManager: WarningManager;
}
