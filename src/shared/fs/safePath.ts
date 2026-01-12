import { resolve, relative, sep } from "node:path";
import process from "node:process";

import { isPathTraversal } from "./pathTraversal.js";

interface SafePathOptions {
  baseDir?: string;
  allowOutsideBase?: boolean;
}

export function resolveSafePath(inputPath: string, options?: SafePathOptions): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("Path must be a non-empty string");
  }

  const trimmed = inputPath.trim();
  const allowOutsideBase = options?.allowOutsideBase ?? false;
  const baseDir = resolve(options?.baseDir ?? process.cwd());

  const resolved = resolve(baseDir, trimmed);

  if (allowOutsideBase) {
    return resolved;
  }

  const relativePath = relative(baseDir, resolved);
  if (relativePath === "" || relativePath === ".") {
    return resolved;
  }

  // @see Issue #215: 共通ユーティリティに統合
  if (isPathTraversal(relativePath)) {
    throw new Error(`Path traversal attempt detected: ${inputPath}`);
  }

  return resolved;
}
