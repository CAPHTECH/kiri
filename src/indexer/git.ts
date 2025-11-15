import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_LS_ARGS = ["ls-files", "-z"] as const;
const GIT_LS_ARGS_WITH_SUBMODULES = ["ls-files", "--recurse-submodules", "-z"] as const;

let warnedAboutRecurseFallback = false;

function parseGitPaths(output: string): string[] {
  return output
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function shouldFallbackWithoutRecurse(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as NodeJS.ErrnoException & { stderr?: string };
  if (typeof err.code === "number" && err.code === 129) {
    // git returns exit code 129 for unknown options
    return true;
  }
  if (typeof err.code === "string" && Number.parseInt(err.code, 10) === 129) {
    // git returns exit code 129 for unknown options
    return true;
  }
  const stderr = err.stderr ?? "";
  return stderr.includes("unknown option") || stderr.includes("does not support");
}

export async function gitLsFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", [...GIT_LS_ARGS_WITH_SUBMODULES], {
      cwd: repoRoot,
    });
    return parseGitPaths(stdout);
  } catch (error) {
    if (shouldFallbackWithoutRecurse(error)) {
      if (!warnedAboutRecurseFallback) {
        console.warn(
          "git ls-files does not support --recurse-submodules on this system. " +
            "Falling back to superproject-only scan; submodule files will be skipped."
        );
        warnedAboutRecurseFallback = true;
      }
      const { stdout } = await execFileAsync("git", [...GIT_LS_ARGS], { cwd: repoRoot });
      return parseGitPaths(stdout);
    }
    throw error;
  }
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
