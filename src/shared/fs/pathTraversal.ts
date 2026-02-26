/**
 * Path Traversal Detection Utility
 *
 * Unified path traversal detection logic extracted from:
 * - normalizePathForDenylist (src/indexer/cli.ts)
 * - resolveSafePath (src/shared/fs/safePath.ts)
 *
 * Uses segment-based detection (not substring) to avoid false positives
 * on patterns like Next.js catch-all routes [...all].
 *
 * @see Issue #215: パストラバーサル検出ロジックの統合
 * @see PR #214: improve path traversal detection accuracy
 */

/**
 * Check if a path contains path traversal attempts
 *
 * Uses segment-based detection to avoid false positives on patterns like:
 * - Next.js catch-all routes: [...all], [[...slug]]
 * - File names containing ".." : bar..baz.ts
 * - Directory names with partial "..": [..bar]
 *
 * @param path - The path to check (supports both Unix and Windows separators)
 * @returns true if path traversal is detected
 *
 * @example
 * isPathTraversal("../etc/passwd")     // true
 * isPathTraversal("foo/../bar")        // true
 * isPathTraversal("[...all]/route.ts") // false (Next.js pattern)
 * isPathTraversal("foo/bar..baz.ts")   // false (filename with ..)
 */
export function isPathTraversal(path: string): boolean {
  // Split on both forward slash and backslash (Windows support)
  const segments = path.split(/[/\\]/);
  return segments.includes("..");
}
