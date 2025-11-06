import { dirname, join, resolve } from "node:path";

import { tryCreateFTSIndex } from "../indexer/schema.js";
import { DuckDBClient } from "../shared/duckdb.js";

import { bootstrapServer, type BootstrapOptions } from "./bootstrap.js";
import { ServerContext } from "./context.js";
import { DegradeController } from "./fallbacks/degradeController.js";
import { resolveRepoId } from "./handlers.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { WarningManager } from "./rpc.js";

export interface CommonServerOptions {
  databasePath: string;
  repoRoot: string;
  allowDegrade?: boolean;
  securityConfigPath?: string;
  securityLockPath?: string;
  allowWriteLock?: boolean;
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
  const databasePath = resolve(options.databasePath);
  const repoRoot = resolve(options.repoRoot);
  const defaultLockPath = join(dirname(databasePath), "security.lock");

  const bootstrapOptions: BootstrapOptions = {};
  if (options.securityConfigPath) {
    bootstrapOptions.securityConfigPath = options.securityConfigPath;
  }
  bootstrapOptions.securityLockPath = options.securityLockPath
    ? resolve(options.securityLockPath)
    : defaultLockPath;
  if (options.allowWriteLock !== undefined) {
    bootstrapOptions.allowWriteLock = options.allowWriteLock;
  }
  const bootstrap = bootstrapServer(bootstrapOptions);

  let db: DuckDBClient | null = null;
  try {
    db = await DuckDBClient.connect({ databasePath, ensureDirectory: true });
    const repoId = await resolveRepoId(db, repoRoot);

    // FTS拡張の利用可否を検出
    const hasFTS = await tryCreateFTSIndex(db);

    const context: ServerContext = {
      db,
      repoId,
      features: {
        fts: hasFTS,
      },
      warningManager: new WarningManager(),
    };

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
