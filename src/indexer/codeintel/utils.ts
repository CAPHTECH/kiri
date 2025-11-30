/**
 * 共通ユーティリティ関数
 *
 * 複数の言語アナライザーで共有されるヘルパー関数を提供します。
 */

import type Parser from "tree-sitter";

import type { SymbolRecord, SnippetRecord } from "./types.js";

/**
 * tree-sitter の Point を 1-based の行番号に変換
 *
 * @param position - tree-sitter の位置情報 (0-based row)
 * @returns 1-based の行番号
 */
export function treeSitterPointToLine(position: Parser.Point): number {
  return position.row + 1;
}

/**
 * シグネチャテキストをサニタイズ
 * - 関数本体 ({...}) を除去
 * - 最大長に切り詰め
 * - 空白を正規化
 *
 * @param nodeText - ノードのテキスト
 * @param options - オプション
 * @returns サニタイズされたシグネチャ
 */
export function sanitizeTreeSitterSignature(
  nodeText: string,
  options: {
    /** trueの場合、切り詰め前に空白を正規化 (Java用) */
    normalizeFirst?: boolean;
    /** 最大文字数 (デフォルト: 200) */
    maxLength?: number;
  } = {}
): string {
  const { normalizeFirst = false, maxLength = 200 } = options;

  // 関数本体を除去
  const bodyIndex = nodeText.indexOf("{");
  const signatureText = bodyIndex >= 0 ? nodeText.substring(0, bodyIndex) : nodeText;

  if (normalizeFirst) {
    // Java: 先に空白を正規化してから切り詰め
    const normalized = signatureText.replace(/\s+/g, " ").trim();
    return normalized.substring(0, maxLength);
  } else {
    // Swift/PHP: 先に切り詰めてから最初の行を取得
    const truncated = signatureText.substring(0, maxLength);
    return truncated.split(/\r?\n/)[0]?.trim().replace(/\s+/g, " ") ?? "";
  }
}

/**
 * シンボル配列をソートしてIDを割り当て
 *
 * @param symbols - symbolIdを除いたシンボル配列
 * @returns symbolIdが割り当てられたシンボル配列
 */
export function assignSymbolIds(symbols: Array<Omit<SymbolRecord, "symbolId">>): SymbolRecord[] {
  // 元の配列を変更しないようにコピーしてからソート
  return [...symbols]
    .sort((a, b) => a.rangeStartLine - b.rangeStartLine)
    .map((item, index) => ({ symbolId: index + 1, ...item }));
}

/**
 * シンボル配列からスニペット配列を生成
 *
 * @param symbols - シンボル配列
 * @returns スニペット配列
 */
export function symbolsToSnippets(symbols: SymbolRecord[]): SnippetRecord[] {
  return symbols.map((s) => ({
    startLine: s.rangeStartLine,
    endLine: s.rangeEndLine,
    symbolId: s.symbolId,
  }));
}

/**
 * 依存関係の重複排除ヘルパー
 *
 * @returns record関数とgetDependencies関数を含むオブジェクト
 */
export function createDependencyRecorder(): {
  /** 依存関係を記録 (重複は自動排除) */
  record: (kind: "path" | "package", dst: string, rel?: string) => void;
  /** 記録された依存関係を取得 */
  getDependencies: () => Array<{ dstKind: "path" | "package"; dst: string; rel: string }>;
} {
  const dependencies = new Map<string, { dstKind: "path" | "package"; dst: string; rel: string }>();

  return {
    record: (kind, dst, rel = "import") => {
      const key = `${kind}:${dst}`;
      if (!dependencies.has(key)) {
        dependencies.set(key, { dstKind: kind, dst, rel });
      }
    },
    getDependencies: () => Array.from(dependencies.values()),
  };
}

/**
 * ファイル内容から行開始位置の配列を構築
 * offsetToLine()と組み合わせて使用
 *
 * @param content - ファイル内容
 * @returns 各行の開始位置の配列 (0-indexed offset)
 */
export function buildLineStartsArray(content: string): number[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

/**
 * オフセットから行番号を取得 (バイナリサーチ)
 *
 * @param lineStarts - buildLineStartsArray()で構築した配列
 * @param offset - バイトオフセット
 * @returns 1-based の行番号
 */
export function offsetToLine(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (lineStarts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low + 1; // 1-based
}

/**
 * ドキュメントコメントをクリーンアップ
 *
 * @param text - コメントテキスト
 * @returns クリーンアップされたテキスト
 */
export function cleanDocComment(text: string): string {
  return text
    .replace(/^\/\/\/\s?/gm, "") // Swift /// コメント
    .replace(/^\/\/!\s?/gm, "") // Rust //! コメント
    .replace(/^\/\*\*\s?|\s?\*\/$/g, "") // /** ... */ の開始/終了
    .replace(/^\/\*!\s?|\s?\*\/$/g, "") // /*! ... */ の開始/終了
    .replace(/^\s*\*\s?/gm, "") // 中間の * プレフィックス
    .trim();
}

/**
 * フォールバックスニペットを生成
 * シンボルが抽出できない場合にファイル全体をカバー
 *
 * @param totalLines - ファイルの総行数
 * @returns スニペットレコード
 */
export function buildFallbackSnippet(totalLines: number): SnippetRecord {
  return { startLine: 1, endLine: totalLines, symbolId: null };
}
