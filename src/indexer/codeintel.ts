import path from "node:path";

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

const SUPPORTED_LANGUAGES = new Set(["TypeScript"]);

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
