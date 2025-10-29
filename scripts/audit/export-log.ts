import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface AuditEntry {
  path: string;
  range: [number, number];
  rationale: string;
}

export function exportAuditLog(entries: AuditEntry[], outputPath: string): string {
  const absolute = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)
  );
  return absolute;
}

const executedDirectly =
  typeof process.argv[1] === "string" && new URL(import.meta.url).pathname === process.argv[1];

if (executedDirectly) {
  const sample: AuditEntry[] = [
    { path: "src/server/main.ts", range: [1, 20], rationale: "MCP起動処理の確認" },
  ];
  const output = exportAuditLog(sample, process.argv[2] ?? "var/audit/sample-log.json");
  console.info(`監査ログを出力しました: ${output}`);
}
