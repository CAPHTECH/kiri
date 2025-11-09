import { dirname, join, resolve } from "node:path";

import { checkFTSAvailability } from "../indexer/schema.js";
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

    // Phase 2: FTS拡張の利用可否を確認（作成はしない）
    let hasFTS = await checkFTSAvailability(db);

    // Phase 3: FTSが存在してもdirty flagが立っている場合は無効化（degrade to ILIKE）
    // CRITICAL: Check if ANY repo is dirty (FTS is global, not per-repo)
    if (hasFTS) {
      try {
        const dirtyCount = await db.all<{ count: number }>(
          `SELECT COUNT(*) as count FROM repo WHERE fts_dirty = true`
        );
        const anyDirty = (dirtyCount[0]?.count ?? 0) > 0;
        if (anyDirty) {
          hasFTS = false; // Disable FTS if ANY repo's index is stale
          console.warn(
            "FTS index is stale (dirty flag set on one or more repos). Using ILIKE fallback. Run indexer to rebuild FTS."
          );
        }
      } catch (error) {
        // If we can't check the dirty flag, err on the side of caution and disable FTS
        hasFTS = false;
        console.warn("Unable to check FTS dirty flag, using ILIKE fallback:", error);
      }
    }

    const warningManager = new WarningManager();

    const context: ServerContext = {
      db,
      repoId,
      features: {
        fts: hasFTS,
      },
      warningManager,
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
