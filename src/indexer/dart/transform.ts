/**
 * Dart Analysis Server の Outline から KIRI の SymbolRecord への変換
 */

import type { SymbolRecord, SnippetRecord } from "../codeintel.js";
import type { Outline, ElementKind } from "./types.js";

/**
 * Outline を SymbolRecord と SnippetRecord に変換
 *
 * @param outline - Analysis Server の Outline
 * @param content - ファイルの内容（行番号計算用）
 * @returns { symbols, snippets }
 */
export function outlineToSymbols(
  outline: Outline,
  content: string
): { symbols: SymbolRecord[]; snippets: SnippetRecord[] } {
  const symbols: Array<Omit<SymbolRecord, "symbolId">> = [];

  // offset → line 変換のための行開始位置配列を事前構築
  const lineStarts = buildLineStartsArray(content);

  function visit(node: Outline): void {
    const kind = mapElementKind(node.element.kind as ElementKind);
    if (kind) {
      const startLine = offsetToLine(lineStarts, node.offset);
      const endLine = offsetToLine(lineStarts, node.offset + node.length);

      symbols.push({
        name: node.element.name,
        kind,
        rangeStartLine: startLine,
        rangeEndLine: endLine,
        signature: buildSignature(node),
        doc: node.element.dartdoc ?? null,
      });
    }

    // 子要素を再帰的に処理
    node.children?.forEach(visit);
  }

  visit(outline);

  // symbolId を採番
  const symbolRecords = symbols
    .sort((a, b) => a.rangeStartLine - b.rangeStartLine)
    .map((item, index) => ({ symbolId: index + 1, ...item }));

  // snippets を生成（各シンボルの範囲に対応）
  const snippets = symbolRecords.map((symbol) => ({
    startLine: symbol.rangeStartLine,
    endLine: symbol.rangeEndLine,
    symbolId: symbol.symbolId,
  }));

  return { symbols: symbolRecords, snippets };
}

/**
 * Dart ElementKind を KIRI の symbol kind にマッピング
 *
 * Phase 2: EXTENSION_TYPE, OPERATOR, TYPE_ALIAS を追加
 */
function mapElementKind(kind: ElementKind): string | null {
  switch (kind) {
    case "CLASS":
    case "CLASS_TYPE_ALIAS":
    case "ENUM":
    case "MIXIN":
    case "EXTENSION":
    case "EXTENSION_TYPE": // Phase 2: Dart 3.0+ extension type
      return "class";

    case "FUNCTION":
    case "METHOD":
    case "GETTER":
    case "SETTER":
    case "CONSTRUCTOR":
    case "OPERATOR": // Phase 2: operator overloading
      return "function";

    case "FIELD":
    case "TOP_LEVEL_VARIABLE":
    case "ENUM_CONSTANT":
      return "property";

    case "FUNCTION_TYPE_ALIAS":
    case "TYPE_ALIAS": // Phase 2: type Foo = Bar;
      return "type";

    case "LIBRARY":
    case "COMPILATION_UNIT":
      // KIRI ではファイル単位なので個別に記録しない
      return null;

    case "PARAMETER":
    case "TYPE_PARAMETER":
    case "UNIT_TEST_GROUP":
    case "UNIT_TEST_TEST":
    case "UNKNOWN":
      // これらの要素は個別にシンボルとして記録しない
      return null;

    default:
      // その他の要素は無視
      return null;
  }
}

/**
 * Outline からシグネチャ文字列を生成
 *
 * 形式: {returnType} {name}{typeParameters}{parameters}
 */
function buildSignature(node: Outline): string | null {
  const element = node.element;
  const parts: string[] = [];

  // 返り値の型
  if (element.returnType) {
    parts.push(element.returnType);
  }

  // 名前
  parts.push(element.name);

  // 型パラメータ
  if (element.typeParameters) {
    parts.push(element.typeParameters);
  }

  // パラメータ
  if (element.parameters) {
    parts.push(element.parameters);
  }

  const signature = parts.join(" ").trim();

  // シグネチャが名前だけの場合は null を返す（フィールドなど）
  return signature === element.name ? null : signature;
}

/**
 * ファイル内容から各行の開始オフセット配列を構築
 *
 * メモリ効率改善: Map(O(n))の代わりに配列(O(m))を使用（n=ファイルサイズ、m=行数）
 *
 * @param content - ファイル内容
 * @returns 各行の開始オフセット配列（0-based offset, 1-based line number）
 */
function buildLineStartsArray(content: string): number[] {
  const lineStarts: number[] = [0]; // 1行目は offset 0 から開始

  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      lineStarts.push(i + 1); // 改行の次の文字が次の行の開始
    }
  }

  return lineStarts;
}

/**
 * オフセットから行番号を二分探索で取得
 *
 * 時間計算量: O(log m) （m=行数）
 *
 * @param lineStarts - 各行の開始オフセット配列
 * @param offset - 検索対象のオフセット（0-based）
 * @returns 行番号（1-based）
 */
function offsetToLine(lineStarts: number[], offset: number): number {
  // 二分探索: offset 以下の最大のインデックスを探す
  let left = 0;
  let right = lineStarts.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (lineStarts[mid]! <= offset) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  // インデックスは0-based、行番号は1-basedなので+1
  return left + 1;
}
