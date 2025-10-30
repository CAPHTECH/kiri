import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { parseSimpleYaml } from "../utils/simpleYaml.js";

export interface SecurityConfig {
  allowed_paths: string[];
  allow_network_egress: boolean;
  allow_subprocess: boolean;
  sensitive_tokens: string[];
}

export interface SecurityStatus {
  config: SecurityConfig;
  configPath: string;
  lockPath: string;
  hash: string;
  lockHash: string | null;
  matches: boolean;
}

/**
 * セキュリティ設定のスキーマ定義（Zodによる型安全な検証）
 */
const SecurityConfigSchema = z.object({
  allowed_paths: z.array(z.string()).min(1, "At least one allowed path required"),
  allow_network_egress: z.boolean(),
  allow_subprocess: z.boolean(),
  sensitive_tokens: z.array(z.string()),
});

export function loadSecurityConfig(configPath?: string): { config: SecurityConfig; hash: string } {
  const path =
    configPath ?? join(fileURLToPath(import.meta.url), "../../../../config/security.yml");
  const content = readFileSync(path, "utf8");
  const parsed = parseSimpleYaml(content);

  // Zodによるスキーマ検証（手動アサーションを置き換え）
  const result = SecurityConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((i) => i.message).join(", ");
    throw new Error(`Security configuration is invalid. Fix the following errors: ${errors}`);
  }

  const hash = createHash("sha256").update(content).digest("hex");
  return { config: result.data, hash };
}

export function readSecurityLock(lockPath?: string): string | null {
  try {
    return readFileSync(resolve(lockPath ?? "var/security.lock"), "utf8").trim();
  } catch {
    return null;
  }
}

export function evaluateSecurityStatus(configPath?: string, lockPath?: string): SecurityStatus {
  const { config, hash } = loadSecurityConfig(configPath);
  const stored = readSecurityLock(lockPath);
  const defaultConfigPath = join(fileURLToPath(import.meta.url), "../../../../config/security.yml");
  return {
    config,
    configPath: configPath ?? defaultConfigPath,
    lockPath: resolve(lockPath ?? "var/security.lock"),
    hash,
    lockHash: stored,
    matches: stored === null ? false : stored === hash,
  };
}

export function assertSecurityBaseline(configPath?: string, lockPath?: string): SecurityStatus {
  const status = evaluateSecurityStatus(configPath, lockPath);
  if (!status.lockHash) {
    throw new Error(
      `Security lock is missing at ${status.lockPath}. Establish baseline by running 'pnpm exec tsx src/client/cli.ts security verify --write-lock'.`
    );
  }
  if (!status.matches) {
    throw new Error(
      `Security configuration at ${status.configPath} does not match lock hash. Review configuration changes before proceeding.`
    );
  }
  return status;
}

export function updateSecurityLock(hash: string, lockPath?: string): string {
  const path = resolve(lockPath ?? "var/security.lock");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${hash}\n`, "utf8");
  return path;
}
