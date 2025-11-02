import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative as relativePath, resolve } from "node:path";

const MAX_SAMPLE_BYTES = 32 * 1024;
const MAX_PREVIEW_FILE_BYTES = 256 * 1024;

export interface DegradeState {
  active: boolean;
  reason: string | null;
  since: Date | null;
}

export interface DegradeSearchResult {
  path: string;
  preview: string;
  matchLine: number;
}

export class DegradeController {
  private state: DegradeState = { active: false, reason: null, since: null };
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = resolve(repoRoot);
  }

  get current(): DegradeState {
    return this.state;
  }

  private shouldTriggerDegrade(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message ?? "";
    const normalized = message.toLowerCase();
    if (message.includes("| SQL:")) {
      return true;
    }
    if (normalized.includes("duckdb")) {
      return true;
    }
    if (normalized.includes("catalog error")) {
      return true;
    }
    if (normalized.includes("io error")) {
      return true;
    }
    return false;
  }

  private isBinaryFile(path: string, size: number): boolean {
    if (size === 0) {
      return false;
    }
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const sampleSize = Math.min(size, MAX_SAMPLE_BYTES);
      const buffer = Buffer.allocUnsafe(sampleSize);
      const bytesRead = readSync(fd, buffer, 0, sampleSize, 0);
      const sample = buffer.subarray(0, bytesRead);
      if (sample.includes(0)) {
        return true;
      }
      const decoded = sample.toString("utf8");
      return decoded.includes("\uFFFD");
    } catch {
      return true;
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }
  }

  enable(reason: string): void {
    if (this.state.active) {
      return;
    }
    this.state = { active: true, reason, since: new Date() };
  }

  disable(): void {
    this.state = { active: false, reason: null, since: null };
  }

  async withResource<T>(operation: () => Promise<T>, reason: string): Promise<T> {
    if (this.state.active) {
      throw new Error(
        `Server is running in degrade mode: ${this.state.reason ?? "unknown"}. Only files.search is available.`
      );
    }
    try {
      const result = await operation();
      return result;
    } catch (error) {
      if (this.shouldTriggerDegrade(error)) {
        this.enable(reason);
      }
      throw error;
    }
  }

  search(query: string, limit = 20): DegradeSearchResult[] {
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return [];
    }
    const results: DegradeSearchResult[] = [];
    this.walkFiles(this.repoRoot, (absolutePath, relativeFile, stats) => {
      if (results.length >= limit) {
        return;
      }
      const fileSize = typeof stats.size === "bigint" ? Number(stats.size) : stats.size;
      if (fileSize > MAX_PREVIEW_FILE_BYTES) {
        return;
      }
      if (this.isBinaryFile(absolutePath, fileSize)) {
        return;
      }
      let content: string;
      try {
        content = readFileSync(absolutePath, "utf8");
      } catch {
        return;
      }
      const lines = content.split(/\r?\n/);
      const matchIndex = lines.findIndex((line) => tokens.every((token) => line.includes(token)));
      if (matchIndex >= 0) {
        const preview = lines.slice(matchIndex, matchIndex + 3).join("\n");
        results.push({ path: relativeFile, preview, matchLine: matchIndex + 1 });
      }
    });
    return results;
  }

  private walkFiles(
    root: string,
    visitor: (
      absolute: string,
      relative: string,
      stats: NonNullable<ReturnType<typeof statSync>>
    ) => void
  ): void {
    const entries = readdirSync(root);
    for (const entry of entries) {
      const absolute = join(root, entry);
      const relative = relativePath(this.repoRoot, absolute);
      const stats = statSync(absolute, { throwIfNoEntry: false });
      if (stats == null) {
        continue;
      }
      if (stats.isDirectory()) {
        this.walkFiles(absolute, visitor);
      } else if (stats.isFile()) {
        visitor(absolute, relative, stats);
      }
    }
  }
}
