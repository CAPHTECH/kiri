export function encode(text: string): number[] {
  const codePoints = Array.from(text);
  return codePoints.map((_, index) => index);
}

/**
 * 共有トークン化ユーティリティ
 * handlers.tsとembedding.tsで一貫したトークン化を提供
 */

export type TokenizationStrategy = "phrase-aware" | "legacy" | "hybrid";

/**
 * 環境変数からトークン化戦略を取得
 */
export function getTokenizationStrategy(): TokenizationStrategy {
  const strategy = process.env.KIRI_TOKENIZATION_STRATEGY?.toLowerCase();
  if (strategy === "legacy" || strategy === "hybrid") {
    return strategy;
  }
  return "phrase-aware"; // デフォルト
}

/**
 * テキストをトークンに分割
 * Unicode文字に対応し、戦略に応じてハイフンの扱いを変更
 *
 * @param text - トークン化するテキスト
 * @param strategy - トークン化戦略（省略時は環境変数から取得）
 * @returns トークンの配列
 */
export function tokenizeText(text: string, strategy?: TokenizationStrategy): string[] {
  const effectiveStrategy = strategy ?? getTokenizationStrategy();

  // レガシーモード: ハイフンも分割（従来の動作）
  if (effectiveStrategy === "legacy") {
    return text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  }

  // phrase-aware または hybrid モード: ハイフンを保持
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
