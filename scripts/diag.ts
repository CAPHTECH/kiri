import { execSync } from "node:child_process";

function run(command: string): string {
  return execSync(command, { encoding: "utf8" }).trim();
}

export function collectDiagnostics(): Record<string, string> {
  return {
    node: run("node --version"),
    pnpm: run("pnpm --version"),
    gitStatus: run("git status -sb")
  };
}

const executedDirectly =
  typeof process.argv[1] === "string" && new URL(import.meta.url).pathname === process.argv[1];

if (executedDirectly) {
  try {
    const report = collectDiagnostics();
    console.info(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error("診断情報の収集に失敗しました", error);
    process.exitCode = 1;
  }
}
