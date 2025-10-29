/**
 * スコアリングウェイトの設定
 * context.bundle の候補ファイルに対するスコアリング重みを定義
 */
export interface ScoringWeights {
  /** テキストマッチ（キーワード検索）の重み */
  textMatch: number;
  /** 編集中ファイル（editing_path）の重み */
  editingPath: number;
  /** 依存関係の重み */
  dependency: number;
  /** 近接ファイル（同一ディレクトリ）の重み */
  proximity: number;
}

/**
 * デフォルトのスコアリング重み
 * - textMatch: 1.0 (基準値)
 * - editingPath: 2.0 (ユーザーが編集中のファイルは高優先度)
 * - dependency: 0.5 (依存関係は重要だが直接マッチより低い)
 * - proximity: 0.25 (近接ファイルは関連性が高い可能性がある)
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  textMatch: 1.0,
  editingPath: 2.0,
  dependency: 0.5,
  proximity: 0.25,
};

/**
 * スコアリングプロファイルをロード
 * 将来的にはYAML設定や環境変数からロード可能にする予定
 *
 * @param _profileName - プロファイル名（現在未使用、将来の拡張用）
 * @returns スコアリング重み設定
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function loadScoringProfile(_profileName?: string): ScoringWeights {
  // TODO: 将来的にはconfig/scoring.yamlから読み込み
  // TODO: 評価メトリクス（P@k, TTFU）を使った自動チューニング
  return DEFAULT_WEIGHTS;
}
