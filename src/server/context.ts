import { DuckDBClient } from "../shared/duckdb.js";

export interface ServerContext {
  db: DuckDBClient;
  repoId: number;
}
