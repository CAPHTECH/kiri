/**
 * Daemon watch mode tests
 *
 * Verifies that `kiri-daemon --watch` starts a file watcher and incrementally
 * updates the DuckDB index when repository files change.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterEach, beforeEach, describe, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { getSocketPath } from "../../src/shared/utils/socket.js";

describe("kiri-daemon --watch", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let tmpDir: string;
  let repoRoot: string;
  let databasePath: string;
  let socketPath: string;
  let daemonProcess: ChildProcess | null = null;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-daemon-watch-"));
    repoRoot = path.join(tmpDir, "repo");
    databasePath = path.join(tmpDir, "index.duckdb");
    socketPath = getSocketPath(databasePath, { ensureDir: true });

    await fs.mkdir(repoRoot, { recursive: true });
    await execa("git", ["init"], { cwd: repoRoot });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    await execa("git", ["config", "user.name", "Test User"], { cwd: repoRoot });
    await execa("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });

    const trackedFile = path.join(repoRoot, "index.ts");
    await fs.writeFile(trackedFile, "export const initial = 'test';\n", "utf-8");
    await execa("git", ["add", "."], { cwd: repoRoot });
    await execa("git", ["commit", "-m", "init"], { cwd: repoRoot });

    // Initial indexing (daemon startup should not need to do full indexing)
    await runIndexer({ repoRoot, databasePath, full: true });
  });

  afterEach(async () => {
    if (daemonProcess) {
      daemonProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        daemonProcess!.on("exit", () => resolve());
        setTimeout(() => {
          if (daemonProcess && !daemonProcess.killed) {
            daemonProcess.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
      daemonProcess = null;
    }

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function startDaemonWithWatch(): Promise<void> {
    const daemonPath = path.resolve(__dirname, "../../dist/src/daemon/daemon.js");

    daemonProcess = spawn(
      process.execPath,
      [
        daemonPath,
        "--repo",
        repoRoot,
        "--db",
        databasePath,
        "--socket-path",
        socketPath,
        "--watch",
        "--daemon-timeout",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Daemon startup timeout")), 60000);
      const stderr = daemonProcess!.stderr;
      if (!stderr) {
        clearTimeout(timeout);
        reject(new Error("Daemon stderr not available"));
        return;
      }

      stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        if (output.includes("Ready to accept connections")) {
          clearTimeout(timeout);
          resolve();
        }
      });

      daemonProcess!.on("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Daemon exited during startup (code=${code ?? "null"} signal=${signal ?? "null"})`
          )
        );
      });

      daemonProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async function waitForIndexedContent(
    databasePath: string,
    marker: string,
    timeoutMs = 15000
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const db = await DuckDBClient.connect({ databasePath });
      try {
        const rows = await db.all<{ count: bigint }>(
          "SELECT COUNT(*) as count FROM blob WHERE content LIKE '%' || ? || '%'",
          [marker]
        );
        const count = rows[0]?.count ?? 0n;
        if (count > 0n) {
          return;
        }
      } finally {
        await db.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for indexed marker: ${marker}`);
  }

  it(
    "incrementally updates the index when tracked files change",
    async () => {
      await startDaemonWithWatch();

      const marker = `modified_${Date.now()}`;
      await fs.writeFile(
        path.join(repoRoot, "index.ts"),
        `export const ${marker} = true;\n`,
        "utf-8"
      );

      await waitForIndexedContent(databasePath, marker);
    },
    60000
  );
});
