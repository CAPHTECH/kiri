import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { exportAuditLog } from "../../scripts/audit/export-log.js";

describe("exportAuditLog", () => {
  it("masks sensitive tokens in audit output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-test-"));
    const output = join(dir, "audit.json");
    const entries = [
      {
        path: "secrets/sk-1234567890ABCDE",
        range: [1, 2] as [number, number],
        rationale: "Detected ghp_1234567890ABCDE during scan",
      },
    ];

    const file = exportAuditLog(entries, output);
    const content = await readFile(file, "utf8");
    const parsed = JSON.parse(content) as { entries: Array<{ path: string; rationale: string }> };

    expect(parsed.entries[0]?.path).toContain("***");
    expect(parsed.entries[0]?.rationale).toContain("***");

    await rm(dir, { recursive: true, force: true });
  });
});
