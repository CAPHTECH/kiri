/**
 * TF-IDF Provider
 *
 * TF-IDF（Term Frequency - Inverse Document Frequency）を計算するプロバイダー。
 * BM25スタイルのTF正規化とIDF計算により、検索精度を向上させる。
 *
 * @see Issue #48: Improve context_bundle stop word coverage and configurability
 * @see Issue #122: IDF重み付けの改善 - TF-IDF完全実装
 */

import type { DuckDBClient } from "../shared/duckdb.js";

import { type IdfProvider, StopWordsService } from "./stop-words.js";

// ============================================================
// 定数
// ============================================================

/**
 * IDFキャッシュの最大サイズ
 * メモリ消費を抑えつつ、典型的なセッションでのキャッシュヒット率を確保
 */
const MAX_CACHE_SIZE = 10000;

/**
 * BM25 IDF計算のスムージングパラメータ
 * df = 0 の場合のゼロ除算を防ぎ、高頻度語へのペナルティを安定させる
 */
const SMOOTHING_FACTOR = 0.5;

/**
 * BM25 TF飽和パラメータ（デフォルト値）
 * TFの増加に対するスコア上昇を飽和させる。1.2-2.0が典型的。
 */
const DEFAULT_K1 = 1.2;

/**
 * BM25 文書長正規化パラメータ（デフォルト値）
 * 0.75が標準的。0に近いほど文書長の影響が小さくなる。
 */
const DEFAULT_B = 0.75;

/**
 * TF上限（スパム防止）
 * 同一語が極端に多く出現するファイルを過度に優遇しない
 */
const DEFAULT_MAX_TF_CAP = 10;

// ============================================================
// TF-IDF設定インターフェース
// ============================================================

/**
 * TF-IDF計算のオプション設定
 */
export interface TfIdfOptions {
  /** BM25 TF飽和パラメータ（デフォルト: 1.2） */
  k1?: number;
  /** BM25 文書長正規化パラメータ（デフォルト: 0.75） */
  b?: number;
  /** TF上限（デフォルト: 10） */
  maxTfCap?: number;
}

// ============================================================
// DuckDbIdfProvider クラス
// ============================================================

/**
 * DuckDB ベースの TF-IDF プロバイダー
 *
 * 遅延計算とLRUキャッシュを使用し、クエリ時のパフォーマンスを最適化。
 * BM25スタイルのTF-IDF計算式を使用:
 *   TF: normalizedTf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)))
 *   IDF: idf = log((N - df + 0.5) / (df + 0.5) + 1)
 *   TF-IDF: tfidf = normalizedTf * idf
 *
 * 正規化された重み(0.0-1.0)を返し、StopWordsService との統合を容易にする。
 */
export class DuckDbIdfProvider implements IdfProvider {
  private readonly cache = new Map<string, number>();
  private totalDocs: number | null = null;
  private maxIdf: number | null = null;
  private avgDocLength: number | null = null;

  // BM25パラメータ
  private readonly k1: number;
  private readonly b: number;
  private readonly maxTfCap: number;

  /**
   * @param db - DuckDBクライアント
   * @param repoId - リポジトリID
   * @param options - TF-IDF計算オプション
   */
  constructor(
    private readonly db: DuckDBClient,
    private readonly repoId: number,
    options?: TfIdfOptions
  ) {
    this.k1 = options?.k1 ?? DEFAULT_K1;
    this.b = options?.b ?? DEFAULT_B;
    this.maxTfCap = options?.maxTfCap ?? DEFAULT_MAX_TF_CAP;
  }

  /**
   * 総ドキュメント数を取得（キャッシュ付き）
   *
   * @returns 総ドキュメント数（最小1）
   */
  async getDocumentCount(): Promise<number> {
    if (this.totalDocs !== null) {
      return this.totalDocs;
    }

    const result = await this.db.all<{ count: number }>(
      `SELECT COUNT(*) as count FROM file WHERE repo_id = ?`,
      [this.repoId]
    );

    // 最小1を保証（ゼロ除算防止）
    this.totalDocs = Math.max(1, result[0]?.count ?? 1);

    // maxIdf も同時に計算（N が確定したため）
    this.maxIdf = this.calculateMaxIdf(this.totalDocs);

    return this.totalDocs;
  }

  /**
   * 特定の語の文書頻度（DF）を取得
   *
   * @param term - 検索語（正規化済み）
   * @returns 語を含むドキュメント数
   */
  async getDocumentFrequency(term: string): Promise<number> {
    const result = await this.db.all<{ count: number }>(
      `SELECT COUNT(DISTINCT f.path) as count
       FROM file f
       JOIN blob b ON b.hash = f.blob_hash
       WHERE f.repo_id = ? AND b.content ILIKE '%' || ? || '%'`,
      [this.repoId, term]
    );

    return result[0]?.count ?? 0;
  }

  /**
   * 同期的にIDF重みを取得（キャッシュヒット時のみ有効値）
   *
   * キャッシュミス時は1.0（ニュートラル重み）を返す。
   * 正確なIDF値が必要な場合は computeIdf() を使用すること。
   *
   * @param word - 対象単語
   * @returns 正規化された重み（0.0-1.0）
   */
  getIdf(word: string): number {
    const normalized = StopWordsService.normalizeToken(word);
    if (!normalized) {
      return 0;
    }

    const cached = this.cache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

    // キャッシュミス時はニュートラル重みを返す
    // 正確な値は computeIdf() で非同期計算
    return 1.0;
  }

  /**
   * 非同期でIDF重みを計算（DB問い合わせを含む）
   *
   * BM25スタイルのIDF計算式を使用:
   *   idf = log((N - df + 0.5) / (df + 0.5) + 1)
   *
   * @param word - 対象単語
   * @returns 正規化された重み（0.0-1.0）
   */
  async computeIdf(word: string): Promise<number> {
    const normalized = StopWordsService.normalizeToken(word);
    if (!normalized) {
      return 0;
    }

    // キャッシュチェック
    const cached = this.cache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

    // 総ドキュメント数を取得
    const N = await this.getDocumentCount();

    // 文書頻度を取得
    const df = await this.getDocumentFrequency(normalized);

    // BM25スタイルIDF計算
    const idf = Math.log((N - df + SMOOTHING_FACTOR) / (df + SMOOTHING_FACTOR) + 1);

    // 0-1 に正規化
    const maxIdf = this.maxIdf ?? this.calculateMaxIdf(N);
    const weight = Math.min(1, Math.max(0, idf / maxIdf));

    // キャッシュに保存（LRU eviction）
    this.addToCache(normalized, weight);

    return weight;
  }

  /**
   * 複数の単語のIDF重みをバッチ計算
   *
   * 複数の単語を一度に計算することで、DB問い合わせのオーバーヘッドを削減。
   *
   * @param words - 対象単語の配列
   * @returns 単語→重みのマップ
   */
  async computeIdfBatch(words: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    // 正規化と重複除去
    const uniqueTerms = new Set<string>();
    for (const word of words) {
      const normalized = StopWordsService.normalizeToken(word);
      if (normalized) {
        uniqueTerms.add(normalized);
      }
    }

    // キャッシュ済みの語を先に処理
    const uncachedTerms: string[] = [];
    for (const term of uniqueTerms) {
      const cached = this.cache.get(term);
      if (cached !== undefined) {
        result.set(term, cached);
      } else {
        uncachedTerms.push(term);
      }
    }

    // 未キャッシュの語を個別計算
    // TODO: 将来的にはバッチクエリで最適化可能
    for (const term of uncachedTerms) {
      const weight = await this.computeIdf(term);
      result.set(term, weight);
    }

    return result;
  }

  // ============================================================
  // TF計算メソッド（Phase 2: TF-IDF完全実装）
  // ============================================================

  /**
   * 平均文書長を取得（キャッシュ付き）
   *
   * 文書長は空白で分割した単語数で計算。
   *
   * @returns 平均文書長（単語数）
   */
  async getAverageDocumentLength(): Promise<number> {
    if (this.avgDocLength !== null) {
      return this.avgDocLength;
    }

    const result = await this.db.all<{ avg_length: number }>(
      `SELECT AVG(
        LENGTH(b.content) - LENGTH(REPLACE(b.content, ' ', '')) + 1
       ) as avg_length
       FROM file f
       JOIN blob b ON b.hash = f.blob_hash
       WHERE f.repo_id = ? AND b.content IS NOT NULL AND LENGTH(b.content) > 0`,
      [this.repoId]
    );

    // デフォルト1000（空リポジトリ対策）
    this.avgDocLength = result[0]?.avg_length ?? 1000;
    return this.avgDocLength;
  }

  /**
   * 生のTerm Frequency（出現回数）を計算
   *
   * @param content - ファイルコンテンツ
   * @param term - 検索語
   * @returns 出現回数（maxTfCapで上限制限）
   */
  computeTf(content: string, term: string): number {
    const normalized = StopWordsService.normalizeToken(term);
    if (!normalized || !content) {
      return 0;
    }

    // 大文字小文字を区別しないマッチング
    const escapedTerm = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedTerm, "gi");
    const matches = content.match(regex);
    const rawTf = matches?.length ?? 0;

    // スパム防止: TF上限を適用
    return Math.min(rawTf, this.maxTfCap);
  }

  /**
   * BM25正規化されたTFを計算
   *
   * 計算式: normalizedTf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)))
   *
   * @param content - ファイルコンテンツ
   * @param term - 検索語
   * @param docLength - 文書長（単語数）
   * @param avgDocLength - 平均文書長
   * @returns 正規化されたTF（0以上）
   */
  computeNormalizedTf(
    content: string,
    term: string,
    docLength: number,
    avgDocLength: number
  ): number {
    const tf = this.computeTf(content, term);
    if (tf === 0) {
      return 0;
    }

    // BM25 TF正規化
    // normalizedTf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)))
    const lengthRatio = docLength / Math.max(avgDocLength, 1);
    const denominator = tf + this.k1 * (1 - this.b + this.b * lengthRatio);
    const normalizedTf = (tf * (this.k1 + 1)) / denominator;

    return normalizedTf;
  }

  /**
   * 複数キーワードのTFを一括計算（効率化）
   *
   * 1回のコンテンツスキャンで全キーワードのTFを計算。
   *
   * @param content - ファイルコンテンツ
   * @param terms - 検索語の配列
   * @returns 語→TFのマップ
   */
  computeTfBatch(content: string, terms: string[]): Map<string, number> {
    const result = new Map<string, number>();

    if (!content) {
      return result;
    }

    for (const term of terms) {
      const normalized = StopWordsService.normalizeToken(term);
      if (normalized && !result.has(normalized)) {
        result.set(normalized, this.computeTf(content, term));
      }
    }

    return result;
  }

  /**
   * 文書長（単語数）を計算
   *
   * @param content - ファイルコンテンツ
   * @returns 単語数
   */
  computeDocumentLength(content: string): number {
    if (!content) {
      return 0;
    }
    // 空白で分割して単語数をカウント
    return content.split(/\s+/).filter((w) => w.length > 0).length;
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    this.cache.clear();
    this.totalDocs = null;
    this.maxIdf = null;
    this.avgDocLength = null;
  }

  /**
   * キャッシュサイズを取得（デバッグ用）
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  // ============================================================
  // プライベートメソッド
  // ============================================================

  /**
   * 理論上の最大IDF値を計算
   *
   * df = 0 の場合（未出現語）のIDF値を計算。
   * この値で正規化することで、すべての重みが0-1の範囲に収まる。
   *
   * @param N - 総ドキュメント数
   * @returns 最大IDF値
   */
  private calculateMaxIdf(N: number): number {
    // df = 0 の場合: log((N + 0.5) / 0.5 + 1)
    return Math.log((N + SMOOTHING_FACTOR) / SMOOTHING_FACTOR + 1);
  }

  /**
   * キャッシュに追加（簡易LRU）
   *
   * キャッシュサイズが上限を超えた場合、最も古いエントリを削除。
   *
   * @param term - 正規化された語
   * @param weight - IDF重み
   */
  private addToCache(term: string, weight: number): void {
    // 簡易LRU: Map の挿入順序を利用
    if (this.cache.size >= MAX_CACHE_SIZE) {
      // 最初のエントリを削除
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(term, weight);
  }
}

// ============================================================
// ファクトリー関数
// ============================================================

/**
 * TF-IDF Provider を作成
 *
 * @param db - DuckDBクライアント
 * @param repoId - リポジトリID
 * @param options - TF-IDF計算オプション（BM25パラメータなど）
 * @returns DuckDbIdfProvider インスタンス
 */
export function createIdfProvider(
  db: DuckDBClient,
  repoId: number,
  options?: TfIdfOptions
): DuckDbIdfProvider {
  return new DuckDbIdfProvider(db, repoId, options);
}
