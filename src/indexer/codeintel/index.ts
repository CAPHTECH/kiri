/**
 * Language Analyzer System - Public API
 *
 * このモジュールは言語アナライザーシステムの公開APIを提供します。
 *
 * 使用例:
 * ```typescript
 * import { LanguageRegistry, type LanguageAnalyzer } from './codeintel/index.js';
 *
 * const registry = LanguageRegistry.getInstance();
 * registry.register(new TypeScriptAnalyzer());
 *
 * const result = await registry.analyze('TypeScript', {
 *   pathInRepo: 'src/index.ts',
 *   content: '...',
 *   fileSet: new Set(['src/index.ts']),
 * });
 * ```
 */

// Types
export type {
  SymbolRecord,
  SnippetRecord,
  DependencyRecord,
  AnalysisContext,
  AnalysisResult,
  LanguageAnalyzer,
} from "./types.js";

export { emptyResult } from "./types.js";

// Registry
export { LanguageRegistry } from "./registry.js";

// Utilities
export {
  treeSitterPointToLine,
  sanitizeTreeSitterSignature,
  assignSymbolIds,
  symbolsToSnippets,
  createDependencyRecorder,
  buildLineStartsArray,
  offsetToLine,
  cleanDocComment,
  buildFallbackSnippet,
} from "./utils.js";

// Language Analyzers
export { TypeScriptAnalyzer, createTypeScriptAnalyzer } from "./typescript/index.js";
export { SwiftAnalyzer, createSwiftAnalyzer } from "./swift/index.js";
export { PHPAnalyzer, createPHPAnalyzer } from "./php/index.js";
export { JavaAnalyzer, createJavaAnalyzer } from "./java/index.js";
export { DartAnalyzer, createDartAnalyzer } from "./dart/index.js";
export { RustAnalyzer, createRustAnalyzer } from "./rust/index.js";
