/**
 * Socket Path Utility for Cross-Platform IPC
 *
 * Generates platform-appropriate IPC paths:
 * - Unix/Linux/macOS: Unix domain socket files (e.g., /path/to/database.duckdb.sock)
 * - Windows: Named pipes (e.g., \\.\pipe\kiri-<hash>)
 */

import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

/**
 * プラットフォームに応じた適切なソケットパスを生成
 *
 * Windows環境では名前付きパイプ形式（\\.\pipe\kiri-<hash>）を使用し、
 * Unix系環境ではファイルシステムパス（<databasePath>.sock）を使用する。
 *
 * @param databasePath - データベースファイルの絶対パス
 * @returns プラットフォーム固有のソケットパス
 *
 * @example
 * // Unix/macOS/Linux
 * getSocketPath("/path/to/database.duckdb")
 * // => "/path/to/database.duckdb.sock"
 *
 * // Windows
 * getSocketPath("C:\\Users\\user\\database.duckdb")
 * // => "\\\\.\\pipe\\kiri-a1b2c3d4..."
 */
export function getSocketPath(databasePath: string): string {
  if (os.platform() === "win32") {
    // Windows: 名前付きパイプを使用
    // データベースパスのハッシュを使ってユニークなパイプ名を生成
    const hash = crypto.createHash("sha256").update(databasePath).digest("hex");
    // 最初の16文字を使用（衝突リスクは極めて低い）
    const pipeName = `kiri-${hash.substring(0, 16)}`;
    return `\\\\.\\pipe\\${pipeName}`;
  } else {
    // Unix系: ファイルシステムパスを使用
    return `${databasePath}.sock`;
  }
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
  const dbDir = path.dirname(databasePath);
  const dbBase = path.basename(databasePath);

  if (platform === "win32") {
    return [
      `Database: ${dbBase} (${dbDir})`,
      `Socket: ${socketPath} (Windows named pipe)`,
      `Note: Pipe name is derived from database path hash for uniqueness`,
    ].join("\n");
  } else {
    return [
      `Database: ${dbBase} (${dbDir})`,
      `Socket: ${socketPath} (Unix domain socket)`,
      `Permissions: Owner-only (0600)`,
    ].join("\n");
  }
}
