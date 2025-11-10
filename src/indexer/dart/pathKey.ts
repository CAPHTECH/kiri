/**
 * Path normalization utilities for Windows case-insensitive filesystem support
 *
 * Fix #3 & #5: Normalize paths on Windows to prevent Map key collisions
 * when same physical path is referenced with different casing (C:\repo vs c:\repo)
 */

import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Normalize workspace root path for use as Map key
 *
 * Windows: Resolves to real path, converts to forward slashes, lowercases
 * Unix: Returns normalized absolute path
 *
 * @param workspaceRoot - Workspace root path (may be relative)
 * @returns Normalized key suitable for Map/Set operations
 */
export function normalizeWorkspaceKey(workspaceRoot: string): string {
  // Normalize to absolute path first
  const normalized = path.resolve(workspaceRoot);

  if (process.platform === "win32") {
    try {
      // Resolve symlinks/junctions to real path
      const realPath = realpathSync.native(normalized);
      // Convert backslashes to forward slashes and lowercase
      return realPath.replace(/\\/g, "/").toLowerCase();
    } catch {
      // If path doesn't exist yet, fall back to normalized path
      return normalized.replace(/\\/g, "/").toLowerCase();
    }
  }

  return normalized;
}

/**
 * Normalize file path for use as Map key
 *
 * Windows: Normalizes path, converts to forward slashes, lowercases
 * Unix: Returns normalized absolute path
 *
 * Note: Does NOT resolve symlinks for files (unlike workspace roots)
 * because overlay files may not exist on disk yet.
 *
 * @param filePath - File path (absolute or relative)
 * @param workspaceRoot - Optional workspace root for resolving relative paths
 * @returns Normalized key suitable for Map/Set operations
 */
export function normalizeFileKey(filePath: string, workspaceRoot?: string): string {
  // Resolve to absolute path
  const normalized = workspaceRoot ? path.resolve(workspaceRoot, filePath) : path.resolve(filePath);

  if (process.platform === "win32") {
    // Normalize and lowercase for case-insensitive comparison
    return path.normalize(normalized).replace(/\\/g, "/").toLowerCase();
  }

  return normalized;
}

/**
 * Normalize any path for consistent comparison
 *
 * Generic version for edge cases where workspace vs file distinction doesn't matter
 *
 * @param inputPath - Any file system path
 * @returns Normalized path
 */
export function normalizePath(inputPath: string): string {
  const normalized = path.normalize(inputPath);

  if (process.platform === "win32") {
    return normalized.replace(/\\/g, "/").toLowerCase();
  }

  return normalized;
}
