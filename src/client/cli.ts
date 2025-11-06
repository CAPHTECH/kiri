#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { bootstrapServer } from "../server/bootstrap.js";
import { evaluateSecurityStatus, updateSecurityLock } from "../shared/security/config.js";

function printUsage(): void {
  console.info(`Usage: pnpm exec tsx src/client/cli.ts <command> [options]\n`);
  console.info(`Commands:`);
  console.info(
    `  security verify [--write-lock] [--db <path>] [--security-lock <path>] [--security-config <path>]`
  );
  console.info(`                                       Verify or create security lock`);
}

interface SecurityVerifyOptions {
  writeLock: boolean;
  databasePath: string;
  securityLockPath?: string;
  securityConfigPath?: string;
}

function parseSecurityVerifyArgs(argv: string[]): SecurityVerifyOptions {
  const options: SecurityVerifyOptions = {
    writeLock: false,
    databasePath: "var/index.duckdb",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--write-lock":
        options.writeLock = true;
        break;
      case "--db":
        if (!argv[i + 1]) {
          throw new Error("--db requires a path argument");
        }
        options.databasePath = argv[i + 1];
        i += 1;
        break;
      case "--security-lock":
        if (!argv[i + 1]) {
          throw new Error("--security-lock requires a path argument");
        }
        options.securityLockPath = argv[i + 1];
        i += 1;
        break;
      case "--security-config":
        if (!argv[i + 1]) {
          throw new Error("--security-config requires a path argument");
        }
        options.securityConfigPath = argv[i + 1];
        i += 1;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}

function formatStatus(securityConfigPath?: string, securityLockPath?: string): string {
  const status = evaluateSecurityStatus(securityConfigPath, securityLockPath);
  const lockInfo = status.lockHash ? `hash=${status.lockHash}` : "missing";
  const matchState = status.matches ? "MATCH" : "MISMATCH";
  return [
    `config: ${status.configPath}`,
    `lock: ${status.lockPath} (${lockInfo})`,
    `state: ${matchState}`,
  ].join("\n");
}

function handleSecurityVerify(argv: string[]): number {
  let options: SecurityVerifyOptions;
  try {
    options = parseSecurityVerifyArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const resolvedDbPath = resolve(options.databasePath);
  const resolvedLockPath = options.securityLockPath
    ? resolve(options.securityLockPath)
    : join(dirname(resolvedDbPath), "security.lock");
  const resolvedConfigPath = options.securityConfigPath
    ? resolve(options.securityConfigPath)
    : undefined;

  const status = evaluateSecurityStatus(resolvedConfigPath, resolvedLockPath);
  if (!status.lockHash && options.writeLock) {
    updateSecurityLock(status.hash, resolvedLockPath);
    console.info("Security lock created.");
    console.info(formatStatus(resolvedConfigPath, resolvedLockPath));
    return 0;
  }
  try {
    bootstrapServer({
      allowWriteLock: options.writeLock,
      securityConfigPath: resolvedConfigPath,
      securityLockPath: resolvedLockPath,
    });
    console.info("Security baseline verified.");
    console.info(formatStatus(resolvedConfigPath, resolvedLockPath));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.info(formatStatus(resolvedConfigPath, resolvedLockPath));
    return 1;
  }
}

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "security": {
      const [subcommand, ...subArgs] = rest;
      if (subcommand === "verify") {
        return handleSecurityVerify(subArgs);
      }
      break;
    }
    case undefined:
      printUsage();
      return 1;
    default:
      break;
  }
  printUsage();
  return 1;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  process.exitCode = main();
}
