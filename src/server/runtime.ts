import { dirname, join, resolve } from "node:path";

import { checkFTSAvailability } from "../indexer/schema.js";
import { DuckDBClient } from "../shared/duckdb.js";
import { ensureDbParentDir, normalizeDbPath, getRepoPathCandidates } from "../shared/utils/path.js";

import { bootstrapServer, type BootstrapOptions } from "./bootstrap.js";
import { createServerContext, FtsStatusCache, ServerContext } from "./context.js";
import { DegradeController } from "./fallbacks/degradeController.js";
import { resolveRepoId } from "./handlers.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { WarningManager } from "./rpc.js";
import { createServerServices } from "./services/index.js";

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
  const repoPathCandidates = getRepoPathCandidates(options.repoRoot);
  const repoRoot = repoPathCandidates[0];
  if (!repoRoot) {
    throw new Error(`Unable to resolve repository root for ${options.repoRoot}`);
  }

  // Fix #4: Normalize databasePath for consistency with indexer
  // Ensure parent exists before normalization to guarantee correct path
  await ensureDbParentDir(options.databasePath);
  const databasePath = normalizeDbPath(options.databasePath);

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

    // Phase 1: Initialize server services (single instance for request sharing)
    const services = createServerServices(db);
    const repoId = await resolveRepoId(db, options.repoRoot, services);

    // Phase 2: FTS拡張の利用可否を確認（作成はしない）
    let hasFTS = await checkFTSAvailability(db);
    const ftsStatus: FtsStatusCache = {
      ready: hasFTS,
      schemaExists: hasFTS,
      anyDirty: false,
      lastChecked: Date.now(),
    };

    // Phase 3: FTSが存在してもdirty flagが立っている場合は無効化（degrade to ILIKE）
    // CRITICAL: Check if ANY repo is dirty (FTS is global, not per-repo)
    if (hasFTS) {
      try {
        const dirtyCount = await db.all<{ count: number }>(
          `SELECT COUNT(*) as count FROM repo WHERE fts_dirty = true`
        );
        const anyDirty = (dirtyCount[0]?.count ?? 0) > 0;
        ftsStatus.anyDirty = anyDirty;
        if (anyDirty) {
          hasFTS = false; // Disable FTS if ANY repo's index is stale
          ftsStatus.ready = false;
          console.warn(
            "FTS index is stale (dirty flag set on one or more repos). Using ILIKE fallback. Run indexer to rebuild FTS."
          );
        } else {
          ftsStatus.ready = true;
        }
      } catch (error) {
        // If we can't check the dirty flag, err on the side of caution and disable FTS
        hasFTS = false;
        ftsStatus.ready = false;
        ftsStatus.schemaExists = false;
        console.warn("Unable to check FTS dirty flag, using ILIKE fallback:", error);
      }
    }

    const warningManager = new WarningManager();

    const context = createServerContext({
      db,
      repoId,
      services,
      features: {
        fts: hasFTS,
      },
      ftsStatusCache: ftsStatus,
      warningManager,
    });

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
