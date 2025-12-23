/**
 * ゾンビdaemon検出・クリーンアップユーティリティ
 *
 * 「プロセス生存 + ソケット消失」状態のゾンビdaemonを検出し、
 * DuckDBロック競合時に自動クリーンアップを行う。
 *
 * @see Issue #168 - ゾンビソケットの自動検出・クリーンアップ機能
 */

import net from "net";

/**
 * プロセスが実行中かどうかを確認
 *
 * @param pid - 確認するプロセスID
 * @returns プロセスが存在する場合はtrue
 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // シグナル0はプロセスを停止せず、存在チェックのみ
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCHはプロセスが存在しないことを意味
    return false;
  }
}

/**
 * DuckDBロック競合エラーメッセージからPIDを抽出
 *
 * エラー形式:
 * "IO Error: Could not set lock on file \"/path/to/db\":
 *  Conflicting lock is held in /path/to/node (PID 38342) by user username"
 *
 * @param errorMessage - DuckDBエラーメッセージ
 * @returns 抽出したPID、または抽出できない場合はnull
 */
export function extractPidFromLockError(errorMessage: string): number | null {
  const match = errorMessage.match(/\(PID\s+(\d+)\)/);
  if (!match || !match[1]) return null;

  const pid = parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * DuckDBロック競合エラーかどうかを判定
 *
 * @param error - チェックするエラー
 * @returns DuckDBロック競合エラーの場合はtrue
 */
export function isDuckDBLockConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("Could not set lock on file") &&
    error.message.includes("Conflicting lock")
  );
}

/**
 * 指定PIDのプロセスがソケットをリッスンしているか確認
 *
 * ソケット接続を試み、pingレスポンスを確認することで
 * プロセスが正常に動作中かを判定
 *
 * @param socketPath - ソケットファイルのパス
 * @param timeoutMs - タイムアウト時間（ミリ秒）
 * @returns プロセスがソケットをリッスンしている場合はtrue
 */
export async function isProcessListeningOnSocket(
  socketPath: string,
  timeoutMs: number = 2000
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    let responseReceived = false;

    socket.on("connect", () => {
      // pingリクエストを送信
      const pingRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      };
      socket.write(JSON.stringify(pingRequest) + "\n");
    });

    socket.on("data", (data) => {
      if (responseReceived) return;

      try {
        const response = JSON.parse(data.toString().trim());
        // 正常なpingレスポンスを確認
        if (response.result && response.result.status === "ok") {
          responseReceived = true;
          clearTimeout(timeout);
          socket.end();
          resolve(true);
        } else {
          clearTimeout(timeout);
          socket.destroy();
          resolve(false);
        }
      } catch {
        clearTimeout(timeout);
        socket.destroy();
        resolve(false);
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * ゾンビプロセスを検出してクリーンアップ
 *
 * プロセスが存在するがソケットをリッスンしていない場合、
 * ゾンビと判定してSIGTERM→SIGKILLで停止する。
 *
 * @param pid - 競合しているプロセスのPID
 * @param socketPath - ソケットファイルのパス
 * @returns クリーンアップ成功（またはプロセス不在）時はtrue、正常動作中のdaemonがいる場合はfalse
 */
export async function detectAndCleanupZombie(pid: number, socketPath: string): Promise<boolean> {
  // プロセスが存在するか確認
  if (!isProcessRunning(pid)) {
    // プロセスが死んでいる（通常のstale lock）
    console.error(`[Daemon] Conflicting process (PID ${pid}) is no longer running`);
    return true; // 呼び出し元でリトライ可能
  }

  // プロセスは生きているが、ソケットをリッスンしているか確認
  const isListening = await isProcessListeningOnSocket(socketPath);

  if (isListening) {
    // 正常に動作中のdaemon
    console.error(`[Daemon] Another daemon (PID ${pid}) is running normally`);
    return false;
  }

  // ゾンビ状態: プロセス生存 + ソケット消失
  console.error(
    `[Daemon] Detected zombie daemon (PID ${pid}): process alive but not listening on socket`
  );

  try {
    // SIGTERMでグレースフルシャットダウンを試みる
    console.error(`[Daemon] Sending SIGTERM to zombie daemon (PID ${pid})`);
    process.kill(pid, "SIGTERM");

    // 最大2秒待機
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!isProcessRunning(pid)) {
        console.error(`[Daemon] Zombie daemon (PID ${pid}) terminated gracefully`);
        return true;
      }
    }

    // SIGKILLで強制終了
    console.error(`[Daemon] Force killing zombie daemon (PID ${pid}) with SIGKILL`);
    process.kill(pid, "SIGKILL");

    // 少し待機
    await new Promise((resolve) => setTimeout(resolve, 100));
    return true;
  } catch (err) {
    // 権限不足などでkillできない場合
    console.error(
      `[Daemon] Failed to kill zombie daemon (PID ${pid}): ${err instanceof Error ? err.message : String(err)}`
    );
    console.error(`[Daemon] Please manually terminate the process: kill ${pid}`);
    return false;
  }
}
