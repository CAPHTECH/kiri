import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { evaluateSecurityStatus } from "../../src/shared/security/config.js";
import { maskValue } from "../../src/shared/security/masker.js";

export interface AuditEntry {
  path: string;
  range: [number, number];
  rangeSource: "symbol" | "window" | "clamped";
  rationale: string;
}

export function exportAuditLog(entries: AuditEntry[], outputPath: string): string {
  const { config } = evaluateSecurityStatus();
  const masked = maskValue(entries, { tokens: config.sensitive_tokens });
  const absolute = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    JSON.stringify({ exportedAt: new Date().toISOString(), entries: masked.masked }, null, 2)
  );
  return absolute;
}

const executedDirectly =
  typeof process.argv[1] === "string" && new URL(import.meta.url).pathname === process.argv[1];

if (executedDirectly) {
  const sample: AuditEntry[] = [
    {
      path: "src/server/main.ts",
      range: [1, 20],
      rangeSource: "clamped",
      rationale: "MCP起動処理の確認",
    },
  ];
  const output = exportAuditLog(sample, process.argv[2] ?? "var/audit/sample-log.json");
  console.info(`監査ログを出力しました: ${output}`);
}
