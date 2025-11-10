/**
 * Socket Path Utility for Cross-Platform IPC
 *
 * Generates platform-appropriate IPC paths:
 * - Unix/Linux/macOS: Unix domain socket files (e.g., /path/to/database.duckdb.sock)
 * - Windows: Named pipes (e.g., \\.\pipe\kiri-<hash>)
 */

import * as crypto from "crypto";
import { mkdirSync } from "node:fs";
import * as os from "os";
import * as path from "path";

const UNIX_SOCKET_PATH_MAX = 96; // macOS 104-byte limitに安全マージンを残す
const SOCKET_PREFIX = "kiri";
const SOCKET_DIR_ENV = "KIRI_SOCKET_DIR";

function sanitizeBaseName(fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9]/g, "-");
  return sanitized.length > 0 ? sanitized.toLowerCase() : "db";
}

function ensureSocketDir(dirPath: string): void {
  try {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw new Error(
      `Failed to prepare socket directory ${dirPath}: ${err.message}. ` +
        `Set ${SOCKET_DIR_ENV} to a writable directory.`
    );
  }
}

function buildFallbackUnixSocketPath(databasePath: string, ensureDir: boolean): string {
  const fallbackDir = process.env[SOCKET_DIR_ENV] || os.tmpdir();
  const hash = crypto.createHash("sha256").update(databasePath).digest("hex");
  const baseName = sanitizeBaseName(path.basename(databasePath));

  const candidates = [
    path.join(fallbackDir, `${SOCKET_PREFIX}-${baseName}-${hash.slice(0, 12)}.sock`),
    path.join(fallbackDir, `${SOCKET_PREFIX}-${hash.slice(0, 12)}.sock`),
    path.join(fallbackDir, `${SOCKET_PREFIX}-${hash.slice(0, 8)}.sock`),
  ];

  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate, "utf8") <= UNIX_SOCKET_PATH_MAX) {
      if (ensureDir) {
        ensureSocketDir(path.dirname(candidate));
      }
      return candidate;
    }
  }

  throw new Error(
    `Unable to construct Unix socket path under ${UNIX_SOCKET_PATH_MAX} characters. ` +
      `Set ${SOCKET_DIR_ENV} to a shorter directory.`
  );
}

/**
 * プラットフォームに応じた適切なソケットパスを生成
 *
 * Windows環境では名前付きパイプ形式（\\.\pipe\kiri-<hash>）を使用し、
 * Unix系環境ではファイルシステムパス（<databasePath>.sock）を使用し、
 * パス長が上限を超える場合は /tmp などの短いディレクトリに自動フォールバックする。
 *
 * **セキュリティ注意事項**:
 * - Unix: ソケットファイルは0600パーミッション（所有者のみアクセス可能）で保護
 *   しつつ、KIRI_SOCKET_DIR でフォールバック先ディレクトリを明示できます。
 * - Windows: 名前付きパイプはデフォルトACLを使用（同一システムの他ユーザーが
 *   アクセス可能な場合がある）。ハッシュベースのパイプ名で曖昧性を提供するが、
 *   マルチユーザー環境では信頼できる環境でのみ使用することを推奨。
 * - Windows環境では KIRI_PIPE_PREFIX 環境変数でパイプ名プレフィックスを
 *   カスタマイズ可能（追加のセキュリティ層として利用可能）
 *
 * @param databasePath - データベースファイルの絶対パス
 * @returns プラットフォーム固有のソケットパス
 *
 * @example
 * // Unix/macOS/Linux
 * getSocketPath("/path/to/database.duckdb")
 * // => "/path/to/database.duckdb.sock"
 *
 * // Windows (デフォルト)
 * getSocketPath("C:\\Users\\user\\database.duckdb")
 * // => "\\\\.\\pipe\\kiri-a1b2c3d4..."
 *
 * // Windows (カスタムプレフィックス)
 * process.env.KIRI_PIPE_PREFIX = "myapp"
 * getSocketPath("C:\\Users\\user\\database.duckdb")
 * // => "\\\\.\\pipe\\myapp-a1b2c3d4..."
 */
export function getSocketPath(databasePath: string, options?: { ensureDir?: boolean }): string {
  const ensureDir = options?.ensureDir ?? false;
  if (os.platform() === "win32") {
    // Windows: 名前付きパイプを使用
    // データベースパスのハッシュを使ってユニークなパイプ名を生成
    const hash = crypto.createHash("sha256").update(databasePath).digest("hex");
    // 環境変数でプレフィックスをカスタマイズ可能（追加のセキュリティ層）
    const prefix = process.env.KIRI_PIPE_PREFIX || SOCKET_PREFIX;
    // 最初の16文字を使用（衝突リスクは極めて低い）
    const pipeName = `${prefix}-${hash.substring(0, 16)}`;
    return `\\\\.\\pipe\\${pipeName}`;
  }

  const defaultSocketPath = `${databasePath}.sock`;
  if (Buffer.byteLength(defaultSocketPath, "utf8") <= UNIX_SOCKET_PATH_MAX) {
    if (ensureDir) {
      ensureSocketDir(path.dirname(defaultSocketPath));
    }
    return defaultSocketPath;
  }

  return buildFallbackUnixSocketPath(databasePath, ensureDir);
}

/**
 * ソケットパスからデータベースパスを推測（Unix系のみ）
 *
 * Windows環境ではハッシュベースのパイプ名を使用するため、
 * この関数は情報損失があり、デバッグ用途にのみ使用すべき。
 *
 * @param socketPath - ソケットパス
 * @returns データベースパス（Unix系の場合）またはnull（Windows/不明な形式）
 */
export function getDatabasePathFromSocket(socketPath: string): string | null {
  if (os.platform() === "win32") {
    // Windowsではパイプ名からデータベースパスを復元できない
    return null;
  }

  // Unix系: .sock拡張子を削除
  if (socketPath.endsWith(".sock")) {
    return socketPath.slice(0, -5); // ".sock" の長さは5
  }

  return null;
}

/**
 * デバッグ用のソケットパス情報を生成
 *
 * @param databasePath - データベースファイルの絶対パス
 * @returns デバッグ情報文字列
 */
export function getSocketPathDebugInfo(databasePath: string): string {
  const socketPath = getSocketPath(databasePath);
  const platform = os.platform();
  const defaultUnixSocket = `${databasePath}.sock`;

  // プラットフォーム固有のpathモジュールを使用して正しくパースする
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const dbDir = pathModule.dirname(databasePath);
  const dbBase = pathModule.basename(databasePath);

  if (platform === "win32") {
    return [
      `Database: ${dbBase} (${dbDir})`,
      `Socket: ${socketPath} (Windows named pipe)`,
      `Note: Pipe name is derived from database path hash for uniqueness`,
    ].join("\n");
  } else {
    const lines = [
      `Database: ${dbBase} (${dbDir})`,
      `Socket: ${socketPath} (Unix domain socket)`,
      `Permissions: Owner-only (0600)`,
    ];

    if (socketPath !== defaultUnixSocket) {
      lines.push(
        `Fallback: Socket path shortened (set ${SOCKET_DIR_ENV} to override base directory)`
      );
    }

    return lines.join("\n");
  }
}
