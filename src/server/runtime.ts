import { resolve } from "node:path";

import { DuckDBClient } from "../shared/duckdb.js";

import { bootstrapServer, type BootstrapOptions } from "./bootstrap.js";
import { ServerContext } from "./context.js";
import { DegradeController } from "./fallbacks/degradeController.js";
import { resolveRepoId } from "./handlers.js";
import { MetricsRegistry } from "./observability/metrics.js";

export interface CommonServerOptions {
  databasePath: string;
  repoRoot: string;
  allowDegrade?: boolean;
  securityConfigPath?: string;
  securityLockPath?: string;
}

export interface ServerRuntime {
  context: ServerContext;
  degrade: DegradeController;
  metrics: MetricsRegistry;
  tokens: string[];
  allowDegrade: boolean;
  close: () => Promise<void>;
}

export async function createServerRuntime(options: CommonServerOptions): Promise<ServerRuntime> {
  const bootstrapOptions: BootstrapOptions = {};
  if (options.securityConfigPath) {
    bootstrapOptions.securityConfigPath = options.securityConfigPath;
  }
  if (options.securityLockPath) {
    bootstrapOptions.securityLockPath = options.securityLockPath;
  }
  const bootstrap = bootstrapServer(bootstrapOptions);

  const databasePath = resolve(options.databasePath);
  const repoRoot = resolve(options.repoRoot);

  let db: DuckDBClient | null = null;
  try {
    db = await DuckDBClient.connect({ databasePath, ensureDirectory: true });
    const repoId = await resolveRepoId(db, repoRoot);
    const context: ServerContext = { db, repoId };
    const degrade = new DegradeController(repoRoot);
    const metrics = new MetricsRegistry();
    const tokens = bootstrap.security.config.sensitive_tokens ?? [];
    const allowDegrade = options.allowDegrade ?? false;

    return {
      context,
      degrade,
      metrics,
      tokens,
      allowDegrade,
      close: async () => {
        if (db) {
          await db.close();
        }
      },
    };
  } catch (error) {
    if (db) {
      await db.close();
    }
    throw error;
  }
}
