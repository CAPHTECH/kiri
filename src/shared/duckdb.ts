import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import duckdb from "duckdb";

export interface DuckDBClientOptions {
  databasePath: string;
  ensureDirectory?: boolean;
  autoGitignore?: boolean;
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

/**
 * Check if a directory is inside a Git repository by walking up the directory tree
 * looking for a .git directory.
 */
async function isInGitRepository(dirPath: string): Promise<boolean> {
  let currentPath = dirPath;

  // Walk up the directory tree until we reach the root
  while (true) {
    const gitPath = join(currentPath, ".git");
    try {
      await access(gitPath);
      return true;
    } catch {
      // .git not found at this level, continue up
    }

    const parentPath = dirname(currentPath);
    // If we've reached the root (parent is same as current), stop
    if (parentPath === currentPath) {
      return false;
    }
    currentPath = parentPath;
  }
}

/**
 * Create a .gitignore file in the specified directory if it doesn't already exist.
 * The .gitignore will contain a wildcard pattern to ignore all files in the directory.
 */
async function createGitignoreIfNeeded(dirPath: string): Promise<void> {
  const gitignorePath = join(dirPath, ".gitignore");

  try {
    await access(gitignorePath);
    // .gitignore already exists, skip to respect user's configuration
  } catch {
    // .gitignore does not exist, create it
    const content =
      "# This directory is managed by the application's database client.\n" +
      "# All files in this directory are ignored to prevent committing database files.\n" +
      "*\n";
    await writeFile(gitignorePath, content, "utf-8");
  }
}

export class DuckDBClient {
  private readonly database: import("duckdb").Database;

  constructor(path: string) {
    this.database = new duckdb.Database(path);
  }

  static async connect(options: DuckDBClientOptions): Promise<DuckDBClient> {
    const dbDir = dirname(options.databasePath);

    if (options.ensureDirectory) {
      await mkdir(dbDir, { recursive: true });
    }

    // Auto-create .gitignore if enabled (default: true)
    const shouldAutoGitignore = options.autoGitignore ?? true;
    if (shouldAutoGitignore) {
      const isInGit = await isInGitRepository(dbDir);
      if (isInGit) {
        await createGitignoreIfNeeded(dbDir);
      }
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
          // @ts-expect-error - duckdb.run expects rest parameters which cannot be strongly typed with unknown[]
          this.database.run(sql, ...params, callback);
        } else {
          this.database.run(sql, callback);
        }
      } else if (hasDefinedParams(params)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.database.run(sql, params as any, callback);
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
          // @ts-expect-error - duckdb.all expects rest parameters which cannot be strongly typed with unknown[]
          this.database.all<T>(sql, ...params, callback);
        } else {
          this.database.all<T>(sql, callback);
        }
      } else if (hasDefinedParams(params)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.database.all<T>(sql, params as any, callback);
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
    // Checkpoint WAL to ensure all writes are flushed to the main database file
    // This is critical for multi-connection scenarios where subsequent connections
    // need to see all changes from previous connections
    try {
      await this.run("CHECKPOINT");
    } catch {
      // Ignore checkpoint errors - database might be in read-only mode or already checkpointed
    }

    await new Promise<void>((resolve, reject) => {
      this.database.close((err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}
