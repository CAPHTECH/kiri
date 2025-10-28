import { spawnSync } from "node:child_process";

export function updateDependencies(extraArgs: string[] = []): number {
  const result = spawnSync("pnpm", ["up", "--latest", ...extraArgs], {
    stdio: "inherit"
  });
  return result.status ?? 1;
}

const executedDirectly =
  typeof process.argv[1] === "string" && new URL(import.meta.url).pathname === process.argv[1];

if (executedDirectly) {
  const status = updateDependencies(process.argv.slice(2));
  if (status !== 0) {
    console.error("依存関係の更新に失敗しました");
  }
  process.exitCode = status;
}
