/**
 * MCP Structured Output用のoutputSchema定義
 *
 * Zod 4のz.toJSONSchema()を使用して、各ツールの戻り値のJSON Schemaを生成。
 * MCP仕様（2025-06-18）のstructuredContent対応に使用。
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/server/tools
 * @see https://zod.dev/json-schema
 */
import { z } from "zod";

// =============================================================================
// context_bundle
// =============================================================================

/**
 * context_bundleの各エントリのスキーマ
 */
export const ContextBundleItemSchema = z.object({
  path: z.string().describe("ファイルパス"),
  range: z.tuple([z.number(), z.number()]).describe("行範囲 [start, end]"),
  rangeSource: z.enum(["symbol", "clamped", "window"]).describe("rangeが生成された根拠"),
  preview: z.string().optional().describe("コードプレビュー（compact=falseの場合）"),
  why: z.array(z.string()).describe("スコアリング理由"),
  score: z.number().describe("関連度スコア"),
});

/**
 * context_bundleの戻り値スキーマ
 */
export const ContextBundleResultSchema = z.object({
  context: z.array(ContextBundleItemSchema).describe("関連コードスニペットの配列"),
  tokens_estimate: z.number().optional().describe("推定トークン数"),
  warnings: z.array(z.string()).optional().describe("警告メッセージ"),
});

// =============================================================================
// files_search
// =============================================================================

/**
 * files_searchの各エントリのスキーマ
 */
export const FilesSearchResultItemSchema = z.object({
  path: z.string().describe("ファイルパス"),
  preview: z.string().optional().describe("マッチしたコンテキスト（compact=falseの場合）"),
  matchLine: z.number().describe("マッチした行番号"),
  lang: z.string().nullable().describe("プログラミング言語"),
  ext: z.string().nullable().describe("ファイル拡張子"),
  score: z.number().describe("検索スコア"),
});

/**
 * files_searchの戻り値スキーマ
 *
 * Note: MCP outputSchema requires type="object" at top level.
 * Claude Code rejects tools with type="array" outputSchema.
 */
export const FilesSearchResultSchema = z.object({
  results: z.array(FilesSearchResultItemSchema).describe("検索結果の配列"),
});

// =============================================================================
// snippets_get
// =============================================================================

/**
 * snippets_getの戻り値スキーマ
 */
export const SnippetResultSchema = z.object({
  path: z.string().describe("ファイルパス"),
  startLine: z.number().describe("開始行番号"),
  endLine: z.number().describe("終了行番号"),
  content: z.string().optional().describe("スニペット内容（compact=falseの場合）"),
  totalLines: z.number().describe("ファイルの総行数"),
  symbolName: z.string().nullable().describe("シンボル名"),
  symbolKind: z.string().nullable().describe("シンボル種別"),
  truncated: z.boolean().optional().describe("行数または文字数の安全上限で切り詰められたか"),
});

// =============================================================================
// deps_closure
// =============================================================================

/**
 * deps_closureのノードスキーマ
 */
export const DepsClosureNodeSchema = z.object({
  kind: z.enum(["path", "package"]).describe("ノード種別"),
  target: z.string().describe("対象パスまたはパッケージ名"),
  depth: z.number().describe("ルートからの深さ"),
});

/**
 * deps_closureのエッジスキーマ
 */
export const DepsClosureEdgeSchema = z.object({
  from: z.string().describe("依存元"),
  to: z.string().describe("依存先"),
  kind: z.enum(["path", "package"]).describe("エッジ種別"),
  rel: z.string().describe("関係タイプ"),
  depth: z.number().describe("エッジの深さ"),
});

/**
 * deps_closureの戻り値スキーマ
 */
export const DepsClosureResultSchema = z.object({
  root: z.string().describe("ルートファイルパス"),
  direction: z.enum(["outbound", "inbound"]).describe("探索方向"),
  nodes: z.array(DepsClosureNodeSchema).describe("依存ノード配列"),
  edges: z.array(DepsClosureEdgeSchema).describe("依存エッジ配列"),
});

// =============================================================================
// semantic_rerank
// =============================================================================

/**
 * semantic_rerankの各エントリのスキーマ
 */
export const SemanticRerankItemSchema = z.object({
  path: z.string().describe("ファイルパス"),
  semantic: z.number().describe("セマンティック類似度スコア"),
  base: z.number().describe("ベーススコア"),
  combined: z.number().describe("統合スコア"),
});

/**
 * semantic_rerankの戻り値スキーマ
 */
export const SemanticRerankResultSchema = z.object({
  candidates: z.array(SemanticRerankItemSchema).describe("リランキングされた候補配列"),
});

// =============================================================================
// JSON Schema生成
// =============================================================================

/**
 * 各ツールのoutputSchemaをJSON Schema形式で生成
 *
 * MCP仕様のtools/listレスポンスで使用される
 */
export const OUTPUT_SCHEMAS = {
  context_bundle: z.toJSONSchema(ContextBundleResultSchema),
  files_search: z.toJSONSchema(FilesSearchResultSchema),
  snippets_get: z.toJSONSchema(SnippetResultSchema),
  deps_closure: z.toJSONSchema(DepsClosureResultSchema),
  semantic_rerank: z.toJSONSchema(SemanticRerankResultSchema),
} as const;
