declare module "duckdb" {
  type RunCallback = (err: Error | null) => void;
  type AllCallback<T> = (err: Error | null, rows: T[]) => void;

  export interface Statement {
    run(callback: RunCallback): void;
    run(params: unknown[], callback: RunCallback): void;
    all<T = Record<string, unknown>>(callback: AllCallback<T>): void;
    all<T = Record<string, unknown>>(params: unknown[], callback: AllCallback<T>): void;
    finalize(callback: RunCallback): void;
  }

  export class Database {
    constructor(path: string);
    run(sql: string, callback: RunCallback): void;
    run(sql: string, params: unknown[], callback: RunCallback): void;
    all<T = Record<string, unknown>>(sql: string, callback: AllCallback<T>): void;
    all<T = Record<string, unknown>>(
      sql: string,
      params: unknown[],
      callback: AllCallback<T>
    ): void;
    exec(sql: string, callback: RunCallback): void;
    prepare(sql: string, callback: (err: Error | null, statement: Statement) => void): void;
    close(callback: RunCallback): void;
  }

  const duckdb: {
    Database: typeof Database;
  };

  export default duckdb;
}
