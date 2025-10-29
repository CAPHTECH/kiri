import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TempRepo {
  path: string;
  cleanup: () => Promise<void>;
}

export async function createTempRepo(files: Record<string, string>): Promise<TempRepo> {
  const prefix = join(tmpdir(), "kiri-repo-");
  const repoDir = await mkdtemp(prefix);

  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Kiri Tester"], { cwd: repoDir });

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(repoDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });

  return {
    path: repoDir,
    cleanup: async () => {
      await rm(repoDir, { recursive: true, force: true });
    },
  };
}
