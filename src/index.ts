export { DuckDBClient, type DuckDBClientOptions } from "./shared/duckdb.js";
export { startDaemon, isDaemonRunning, type StartDaemonOptions } from "./client/start-daemon.js";
export { buildContextBundleRequest } from "./client/index.js";
export { bootstrapServer, type BootstrapOptions } from "./server/bootstrap.js";
export {
  createServerRuntime,
  type CommonServerOptions,
  type ServerRuntime,
} from "./server/runtime.js";
export { startServer, type ServerOptions } from "./server/main.js";
export { ensureDatabaseIndexed } from "./server/indexBootstrap.js";
export { IndexWatcher, type IndexWatcherOptions } from "./indexer/watch.js";
export { runIndexer } from "./indexer/cli.js";
export { DaemonLifecycle } from "./daemon/lifecycle.js";
