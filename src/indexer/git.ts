import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitLsFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: repoRoot });
  return stdout
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export async function getHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

export async function getDefaultBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    });
    const branch = stdout.trim();
    if (branch === "HEAD" || branch.length === 0) {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

export async function gitDiffNameOnly(repoRoot: string, sinceRef: string): Promise<string[]> {
  const args = ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", sinceRef, "HEAD"];
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
  return stdout
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
