import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import duckdb from "duckdb";

export interface DuckDBClientOptions {
  databasePath: string;
  ensureDirectory?: boolean;
}

type QueryParams = unknown[] | Record<string, unknown>;

function hasDefinedParams(params: QueryParams): boolean {
  return Array.isArray(params) ? params.length > 0 : Object.keys(params).length > 0;
}

function assertNoUndefined(sql: string, params: QueryParams): void {
  if (Array.isArray(params)) {
    const index = params.findIndex((value) => value === undefined);
    if (index >= 0) {
      throw new Error(`Parameter ${index} is undefined for SQL: ${sql}`);
    }
  } else {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) {
        throw new Error(`Parameter ${key} is undefined for SQL: ${sql}`);
      }
    }
  }
}

export class DuckDBClient {
  private readonly database: duckdb.Database;

  constructor(path: string) {
    this.database = new duckdb.Database(path);
  }

  static async connect(options: DuckDBClientOptions): Promise<DuckDBClient> {
    if (options.ensureDirectory) {
      await mkdir(dirname(options.databasePath), { recursive: true });
    }
    return new DuckDBClient(options.databasePath);
  }

  async run(sql: string, params: QueryParams = []): Promise<void> {
    assertNoUndefined(sql, params);
    await new Promise<void>((resolve, reject) => {
      const callback = (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };
      if (Array.isArray(params)) {
        if (params.length > 0) {
          this.database.run(sql, ...params, callback);
        } else {
          this.database.run(sql, callback);
        }
      } else if (hasDefinedParams(params)) {
        this.database.run(sql, params, callback);
      } else {
        this.database.run(sql, callback);
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} | SQL: ${sql} | Params: ${JSON.stringify(params)}`);
    });
  }

  async all<T>(sql: string, params: QueryParams = []): Promise<T[]> {
    assertNoUndefined(sql, params);
    return await new Promise<T[]>((resolve, reject) => {
      const callback = (err: Error | null, rows: T[]) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows);
      };
      if (Array.isArray(params)) {
        if (params.length > 0) {
          this.database.all<T>(sql, ...params, callback);
        } else {
          this.database.all<T>(sql, callback);
        }
      } else if (hasDefinedParams(params)) {
        this.database.all<T>(sql, params, callback);
      } else {
        this.database.all<T>(sql, callback);
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} | SQL: ${sql} | Params: ${JSON.stringify(params)}`);
    });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.run("BEGIN TRANSACTION");
    try {
      const result = await fn();
      await this.run("COMMIT");
      return result;
    } catch (error) {
      await this.run("ROLLBACK").catch(() => {
        // Ignore rollback errors so original error is surfaced.
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.database.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}
