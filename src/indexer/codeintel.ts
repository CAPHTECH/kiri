import path from "node:path";

import Parser from "tree-sitter";
import Swift from "tree-sitter-swift";
import ts from "typescript";

export interface SymbolRecord {
  symbolId: number;
  name: string;
  kind: string;
  rangeStartLine: number;
  rangeEndLine: number;
  signature: string | null;
  doc: string | null;
}

export interface SnippetRecord {
  startLine: number;
  endLine: number;
  symbolId: number | null;
}

export interface DependencyRecord {
  dstKind: "path" | "package";
  dst: string;
  rel: string;
}

interface AnalysisResult {
  symbols: SymbolRecord[];
  snippets: SnippetRecord[];
  dependencies: DependencyRecord[];
}

const SUPPORTED_LANGUAGES = new Set(["TypeScript", "Swift"]);

function sanitizeSignature(source: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(source);
  const endCandidate = node.forEachChild((child) => {
    if (ts.isBlock(child) || ts.isModuleBlock(child)) {
      return child.getFullStart();
    }
    return undefined;
  });
  const end = typeof endCandidate === "number" ? endCandidate : node.getEnd();
  const snippet = source.text.slice(start, Math.min(end, start + 200));
  return snippet.split(/\r?\n/)[0]?.trim().replace(/\s+/g, " ") ?? "";
}

function getDocComment(node: ts.Node): string | null {
  const tags = ts.getJSDocCommentsAndTags(node);
  const parts: string[] = [];
  for (const tag of tags) {
    if (ts.isJSDoc(tag)) {
      if (typeof tag.comment === "string") {
        parts.push(tag.comment);
      } else if (Array.isArray(tag.comment)) {
        parts.push(
          tag.comment.map((part) => (typeof part === "string" ? part : part.text)).join("")
        );
      }
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n").trim() || null;
}

function toLineNumber(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

// ========================================
// Swift analyzer helpers
// ========================================

type SwiftNode = Parser.SyntaxNode;

/**
 * Swiftのシグネチャをサニタイズ（本体を除外し、最初の200文字に制限）
 */
function sanitizeSwiftSignature(node: SwiftNode, content: string): string {
  const nodeText = content.substring(node.startIndex, node.endIndex);
  // 関数本体（{...}）を除外
  const bodyIndex = nodeText.indexOf("{");
  const signatureText = bodyIndex >= 0 ? nodeText.substring(0, bodyIndex) : nodeText;
  // 最初の200文字に制限し、1行に圧縮
  const truncated = signatureText.substring(0, 200);
  return truncated.split(/\r?\n/)[0]?.trim().replace(/\s+/g, " ") ?? "";
}

/**
 * Swiftのドキュメントコメント（/// または /＊＊ ＊/）を抽出
 */
function getSwiftDocComment(node: SwiftNode, content: string): string | null {
  const parent = node.parent;
  if (!parent) return null;

  // 親ノードのすべての子から、このノードの直前にあるコメントを探す
  const precedingComments: string[] = [];
  const siblings = parent.children; // namedChildrenではなくchildrenを使用
  const nodeIndex = siblings.indexOf(node);

  // このノードより前の兄弟を逆順で調べる
  for (let i = nodeIndex - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (!sibling) continue;

    // commentまたはmultiline_commentをチェック
    if (sibling.type === "comment" || sibling.type === "multiline_comment") {
      const commentText = content.substring(sibling.startIndex, sibling.endIndex);
      // /// または /** */ 形式のドキュメントコメントのみ抽出
      if (commentText.startsWith("///") || commentText.startsWith("/**")) {
        const cleanedComment = commentText
          .replace(/^\/\/\/\s?/gm, "")
          .replace(/^\/\*\*\s?|\s?\*\/$/g, "")
          .replace(/^\s*\*\s?/gm, "")
          .trim();
        precedingComments.unshift(cleanedComment);
      }
    } else if (
      sibling.type !== "{" &&
      sibling.type !== "}" &&
      !sibling.text.trim().match(/^\s*$/)
    ) {
      // コメント以外の実質的なノードに到達したら終了
      break;
    }
  }

  if (precedingComments.length === 0) {
    return null;
  }

  return precedingComments.join("\n");
}

/**
 * tree-sitterの位置情報から行番号を取得（1-based）
 */
function toSwiftLineNumber(position: Parser.Point): number {
  return position.row + 1;
}

function createSymbolRecords(source: ts.SourceFile): SymbolRecord[] {
  const results: Array<Omit<SymbolRecord, "symbolId">> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      results.push({
        name: node.name.getText(source),
        kind: "function",
        rangeStartLine: toLineNumber(source, node.getStart(source)),
        rangeEndLine: toLineNumber(source, node.getEnd()),
        signature: sanitizeSignature(source, node),
        doc: getDocComment(node),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      results.push({
        name: node.name.getText(source),
        kind: "class",
        rangeStartLine: toLineNumber(source, node.getStart(source)),
        rangeEndLine: toLineNumber(source, node.getEnd()),
        signature: sanitizeSignature(source, node),
        doc: getDocComment(node),
      });
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      results.push({
        name: node.name.getText(source),
        kind: "interface",
        rangeStartLine: toLineNumber(source, node.getStart(source)),
        rangeEndLine: toLineNumber(source, node.getEnd()),
        signature: sanitizeSignature(source, node),
        doc: getDocComment(node),
      });
    } else if (ts.isEnumDeclaration(node) && node.name) {
      results.push({
        name: node.name.getText(source),
        kind: "enum",
        rangeStartLine: toLineNumber(source, node.getStart(source)),
        rangeEndLine: toLineNumber(source, node.getEnd()),
        signature: sanitizeSignature(source, node),
        doc: getDocComment(node),
      });
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const name = node.name.getText(source);
      results.push({
        name,
        kind: "method",
        rangeStartLine: toLineNumber(source, node.getStart(source)),
        rangeEndLine: toLineNumber(source, node.getEnd()),
        signature: sanitizeSignature(source, node),
        doc: getDocComment(node),
      });
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);

  return results
    .sort((a, b) => a.rangeStartLine - b.rangeStartLine)
    .map((item, index) => ({ symbolId: index + 1, ...item }));
}

/**
 * Swiftのシンボルレコードを作成
 */
function createSwiftSymbolRecords(tree: Parser.Tree, content: string): SymbolRecord[] {
  const results: Array<Omit<SymbolRecord, "symbolId">> = [];

  /**
   * 子ノードから識別子名を抽出（再帰的に探索）
   */
  function extractName(node: SwiftNode): string | null {
    function findIdentifier(n: SwiftNode): SwiftNode | null {
      if (n.type === "type_identifier" || n.type === "simple_identifier") {
        return n;
      }
      for (const child of n.namedChildren) {
        const found = findIdentifier(child);
        if (found) return found;
      }
      return null;
    }

    const identifierNode = findIdentifier(node);
    return identifierNode
      ? content.substring(identifierNode.startIndex, identifierNode.endIndex)
      : null;
  }

  /**
   * class_declarationのキーワードから種類を判定
   */
  function getClassDeclKind(node: SwiftNode): string | null {
    for (const child of node.children) {
      if (child.type === "class") return "class";
      if (child.type === "struct") return "struct";
      if (child.type === "enum") return "enum";
      if (child.type === "extension") return "extension";
    }
    return null;
  }

  /**
   * ツリーを再帰的にトラバースしてシンボルを抽出
   */
  function visit(node: SwiftNode): void {
    // class_declaration: class/struct/enum/extension
    if (node.type === "class_declaration") {
      const kind = getClassDeclKind(node);
      const name = extractName(node);
      if (kind && name) {
        results.push({
          name,
          kind,
          rangeStartLine: toSwiftLineNumber(node.startPosition),
          rangeEndLine: toSwiftLineNumber(node.endPosition),
          signature: sanitizeSwiftSignature(node, content),
          doc: getSwiftDocComment(node, content),
        });
      }
    }
    // protocol_declaration
    else if (node.type === "protocol_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "protocol",
          rangeStartLine: toSwiftLineNumber(node.startPosition),
          rangeEndLine: toSwiftLineNumber(node.endPosition),
          signature: sanitizeSwiftSignature(node, content),
          doc: getSwiftDocComment(node, content),
        });
      }
    }
    // function_declaration: トップレベル関数またはメソッド
    else if (node.type === "function_declaration") {
      const name = extractName(node);
      if (name) {
        // 親がclass_bodyの場合はmethod、それ以外はfunction
        const kind = node.parent?.type === "class_body" ? "method" : "function";
        results.push({
          name,
          kind,
          rangeStartLine: toSwiftLineNumber(node.startPosition),
          rangeEndLine: toSwiftLineNumber(node.endPosition),
          signature: sanitizeSwiftSignature(node, content),
          doc: getSwiftDocComment(node, content),
        });
      }
    }
    // init_declaration: イニシャライザ
    else if (node.type === "init_declaration") {
      results.push({
        name: "init",
        kind: "initializer",
        rangeStartLine: toSwiftLineNumber(node.startPosition),
        rangeEndLine: toSwiftLineNumber(node.endPosition),
        signature: sanitizeSwiftSignature(node, content),
        doc: getSwiftDocComment(node, content),
      });
    }
    // property_declaration: プロパティ（クラス/構造体/プロトコル/エクステンション内のみ）
    else if (node.type === "property_declaration") {
      // 親がclass_body、struct_body、protocol_body、enum_class_body、extension_bodyの場合のみプロパティとして扱う
      const isClassMember =
        node.parent?.type === "class_body" ||
        node.parent?.type === "struct_body" ||
        node.parent?.type === "protocol_body" ||
        node.parent?.type === "enum_class_body" ||
        node.parent?.type === "extension_body";

      if (isClassMember) {
        const name = extractName(node);
        if (name) {
          results.push({
            name,
            kind: "property",
            rangeStartLine: toSwiftLineNumber(node.startPosition),
            rangeEndLine: toSwiftLineNumber(node.endPosition),
            signature: sanitizeSwiftSignature(node, content),
            doc: getSwiftDocComment(node, content),
          });
        }
      }
    }
    // protocol_function_declaration: プロトコル内のメソッド宣言
    else if (node.type === "protocol_function_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "protocol_method",
          rangeStartLine: toSwiftLineNumber(node.startPosition),
          rangeEndLine: toSwiftLineNumber(node.endPosition),
          signature: sanitizeSwiftSignature(node, content),
          doc: getSwiftDocComment(node, content),
        });
      }
    }

    // 子ノードを再帰的に訪問
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);

  return results
    .sort((a, b) => a.rangeStartLine - b.rangeStartLine)
    .map((item, index) => ({ symbolId: index + 1, ...item }));
}

function normalizePathSpecifier(
  sourcePath: string,
  specifier: string,
  fileSet: Set<string>
): { kind: "path" | "package"; target: string } | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const baseDir = path.posix.dirname(sourcePath);
    // Strip .js extension if present (ESM imports use .js but source files are .ts)
    const pathWithoutJs = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
    const joined = path.posix.normalize(path.posix.join(baseDir, pathWithoutJs));
    const candidates = [
      joined,
      `${joined}.ts`,
      `${joined}.tsx`,
      `${joined}.js`,
      `${joined}.jsx`,
      `${joined}/index.ts`,
      `${joined}/index.tsx`,
    ];
    for (const candidate of candidates) {
      if (fileSet.has(candidate)) {
        return { kind: "path", target: candidate };
      }
    }
    return null;
  }

  return { kind: "package", target: specifier };
}

function collectDependencies(
  sourcePath: string,
  source: ts.SourceFile,
  fileSet: Set<string>
): DependencyRecord[] {
  const dependencies = new Map<string, DependencyRecord>();

  const record = (kind: "path" | "package", dst: string) => {
    const key = `${kind}:${dst}`;
    if (!dependencies.has(key)) {
      dependencies.set(key, { dstKind: kind, dst, rel: "import" });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = normalizePathSpecifier(sourcePath, node.moduleSpecifier.text, fileSet);
      if (target) {
        record(target.kind, target.target);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = normalizePathSpecifier(sourcePath, node.moduleSpecifier.text, fileSet);
      if (target) {
        record(target.kind, target.target);
      }
    } else if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];
      if (
        node.expression.getText(source) === "require" &&
        node.arguments.length === 1 &&
        firstArg &&
        ts.isStringLiteral(firstArg)
      ) {
        const target = normalizePathSpecifier(sourcePath, firstArg.text, fileSet);
        if (target) {
          record(target.kind, target.target);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);

  return Array.from(dependencies.values());
}

/**
 * Swiftのimport文を解析して依存関係を収集
 */
function collectSwiftDependencies(
  sourcePath: string,
  tree: Parser.Tree,
  content: string,
  fileSet: Set<string>
): DependencyRecord[] {
  const dependencies = new Map<string, DependencyRecord>();

  const record = (kind: "path" | "package", dst: string) => {
    const key = `${kind}:${dst}`;
    if (!dependencies.has(key)) {
      dependencies.set(key, { dstKind: kind, dst, rel: "import" });
    }
  };

  function visit(node: SwiftNode): void {
    if (node.type === "import_declaration") {
      // import_declarationの子からidentifierを抽出
      const identifier = node.namedChildren.find((child) => child.type === "identifier");
      if (identifier) {
        const moduleName = content.substring(identifier.startIndex, identifier.endIndex);

        // Swiftファイルへの相対パスかどうかをチェック
        // 通常はシステムモジュール（Foundation, UIKit等）が多いため"package"として扱う
        const baseDir = path.posix.dirname(sourcePath);
        const swiftPath = path.posix.normalize(path.posix.join(baseDir, `${moduleName}.swift`));

        if (fileSet.has(swiftPath)) {
          record("path", swiftPath);
        } else {
          record("package", moduleName);
        }
      }
    }

    // 子ノードを再帰的に訪問
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);

  return Array.from(dependencies.values());
}

export function analyzeSource(
  pathInRepo: string,
  lang: string | null,
  content: string,
  fileSet: Set<string>
): AnalysisResult {
  const normalizedLang = lang ?? "";
  if (!SUPPORTED_LANGUAGES.has(normalizedLang)) {
    return { symbols: [], snippets: [], dependencies: [] };
  }

  // Swift言語の場合、tree-sitterを使用
  if (normalizedLang === "Swift") {
    try {
      // 各ファイルごとに新しいパーサーインスタンスを作成（並行処理の安全性のため）
      const parser = new Parser();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parser.setLanguage(Swift as any);
      const tree = parser.parse(content);
      const symbols = createSwiftSymbolRecords(tree, content);

      const snippets: SnippetRecord[] = symbols.map((symbol) => ({
        startLine: symbol.rangeStartLine,
        endLine: symbol.rangeEndLine,
        symbolId: symbol.symbolId,
      }));

      const dependencies = collectSwiftDependencies(pathInRepo, tree, content, fileSet);

      return { symbols, snippets, dependencies };
    } catch (error) {
      // パース失敗時は空の結果を返して他のファイルの処理を継続
      console.error(`Failed to parse Swift file ${pathInRepo}:`, error);
      return { symbols: [], snippets: [], dependencies: [] };
    }
  }

  // TypeScript言語の場合、TypeScript Compiler APIを使用
  const sourceFile = ts.createSourceFile(pathInRepo, content, ts.ScriptTarget.Latest, true);
  const symbols = createSymbolRecords(sourceFile);

  const snippets: SnippetRecord[] = symbols.map((symbol) => ({
    startLine: symbol.rangeStartLine,
    endLine: symbol.rangeEndLine,
    symbolId: symbol.symbolId,
  }));

  const dependencies = collectDependencies(pathInRepo, sourceFile, fileSet);

  return { symbols, snippets, dependencies };
}

export function buildFallbackSnippet(totalLines: number): SnippetRecord {
  return { startLine: 1, endLine: totalLines, symbolId: null };
}
