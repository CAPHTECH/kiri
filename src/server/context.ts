import { DuckDBClient } from "../shared/duckdb.js";

export interface ServerContext {
  db: DuckDBClient;
  repoId: number;
  features?: {
    fts?: boolean; // FTS拡張が利用可能かどうか
  };
}
