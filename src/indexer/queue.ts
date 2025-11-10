import PQueue from "p-queue";

/**
 * DuckDB single-writer制約対応: databasePathごとにindexer実行をキューイング
 *
 * 背景:
 * - DuckDBは1ファイル1ライターのみサポート
 * - fts_status/generation追加でALTER TABLE + 全件UPDATEが実行され、接続時間が延長
 * - 複数indexer並列実行時にカタログ競合が発生し、repo table消失やデータ損失が起きる
 *
 * 解決策:
 * - 同じdatabasePathに対するrunIndexer()呼び出しを直列化
 * - p-queue (concurrency: 1) でファイルごとに排他制御
 *
 * @see Critical Review Fix #5 - Concurrency test failures
 */

const queueMap = new Map<string, PQueue>();

/**
 * 指定されたdatabasePath用のキューを取得（初回はconcurrency=1で作成）
 *
 * @param databasePath - DuckDBファイルパス
 * @returns databasePath専用のキュー
 */
export function getIndexerQueue(databasePath: string): PQueue {
  if (!queueMap.has(databasePath)) {
    queueMap.set(databasePath, new PQueue({ concurrency: 1 }));
  }
  return queueMap.get(databasePath)!;
}

/**
 * テスト用: 特定databasePathのキューをクリア
 *
 * @param databasePath - クリア対象のパス
 */
export function clearQueue(databasePath: string): void {
  const queue = queueMap.get(databasePath);
  if (queue) {
    queue.clear();
    queueMap.delete(databasePath);
  }
}

/**
 * テスト用: すべてのキューをクリア
 */
export function clearAllQueues(): void {
  for (const queue of queueMap.values()) {
    queue.clear();
  }
  queueMap.clear();
}
