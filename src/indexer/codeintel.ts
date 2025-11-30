/**
 * Code Intelligence API
 *
 * 言語アナライザーシステムの公開APIを提供するファサード。
 * 実際の解析処理は codeintel/ モジュールの LanguageRegistry に委譲。
 *
 * 使用例:
 * ```typescript
 * import { analyzeSource } from './codeintel.js';
 *
 * const result = await analyzeSource('src/index.ts', 'TypeScript', content, fileSet);
 * ```
 */

// 型とユーティリティをre-export
export type {
  SymbolRecord,
  SnippetRecord,
  DependencyRecord,
  AnalysisContext,
  AnalysisResult,
} from "./codeintel/types.js";

export { buildFallbackSnippet } from "./codeintel/utils.js";

// Registry と Analyzer をインポート
import { createDartAnalyzer } from "./codeintel/dart/index.js";
import { createJavaAnalyzer } from "./codeintel/java/index.js";
import { createPHPAnalyzer } from "./codeintel/php/index.js";
import { LanguageRegistry } from "./codeintel/registry.js";
import { createRustAnalyzer } from "./codeintel/rust/index.js";
import { createSwiftAnalyzer } from "./codeintel/swift/index.js";
import type { AnalysisResult } from "./codeintel/types.js";
import { createTypeScriptAnalyzer } from "./codeintel/typescript/index.js";

// シングルトンレジストリを初期化
const registry = LanguageRegistry.getInstance();

// 全言語アナライザーを登録
registry.register(createTypeScriptAnalyzer());
registry.register(createSwiftAnalyzer());
registry.register(createPHPAnalyzer());
registry.register(createJavaAnalyzer());
registry.register(createDartAnalyzer());
registry.register(createRustAnalyzer());

/**
 * ソースコードを解析してシンボル、スニペット、依存関係を抽出
 *
 * @param pathInRepo - リポジトリ内のファイルパス
 * @param lang - 言語名 (TypeScript, Swift, PHP, Java, Dart など)
 * @param content - ファイルコンテンツ
 * @param fileSet - リポジトリ内の全ファイルパスセット (依存関係解決用)
 * @param workspaceRoot - ワークスペースルート (Dart 解析で必須)
 * @returns シンボル、スニペット、依存関係を含む解析結果
 */
export async function analyzeSource(
  pathInRepo: string,
  lang: string | null,
  content: string,
  fileSet: Set<string>,
  workspaceRoot?: string
): Promise<AnalysisResult> {
  const normalizedLang = lang ?? "";

  // サポート対象言語かチェック
  if (!registry.isSupported(normalizedLang)) {
    return { symbols: [], snippets: [], dependencies: [] };
  }

  // レジストリ経由で解析を実行
  // exactOptionalPropertyTypes対応: workspaceRootはundefinedの場合は省略
  return await registry.analyze(normalizedLang, {
    pathInRepo,
    content,
    fileSet,
    ...(workspaceRoot !== undefined && { workspaceRoot }),
  });
}

/**
 * 全言語アナライザーのリソースをクリーンアップ
 *
 * プロセス終了前に呼び出すことで、
 * Dart Analysis Server などの外部プロセスを適切に終了
 */
export async function cleanup(): Promise<void> {
  await registry.cleanup();
}
