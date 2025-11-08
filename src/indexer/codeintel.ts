import { createRequire } from "node:module";
import path from "node:path";

import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import Swift from "tree-sitter-swift";
import ts from "typescript";

// tree-sitter-php is a CommonJS module, so import it using require.
// tree-sitter-php: Using version 0.22.8 for compatibility with tree-sitter 0.22.4.
// Version 0.24.2 had a nodeTypeInfo bug that caused runtime errors.
// php_only: for pure PHP files (<?php at start)
// php: for HTML-mixed PHP files (HTML with <?php ... ?> tags)
const require = createRequire(import.meta.url);
const PHPModule = require("tree-sitter-php");
const PHP_ONLY = PHPModule.php_only;
const PHP_MIXED = PHPModule.php;

// Dart Analysis Server integration
// eslint-disable-next-line import/order
import { analyzeDartSource } from "./dart/analyze.js";

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

const SUPPORTED_LANGUAGES = new Set(["TypeScript", "Swift", "PHP", "Java", "Dart"]);

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

// ========================================
// PHP analyzer helpers
// ========================================

type PHPNode = Parser.SyntaxNode;

/**
 * Detect whether PHP file is pure PHP or HTML-mixed.
 * Pure PHP: starts with <?php tag (possibly after whitespace, shebang, or BOM)
 * HTML-mixed: contains HTML content before <?php tag
 *
 * Handles:
 * - Case-insensitive PHP tags (<?php, <?PHP)
 * - Short tags (<?=)
 * - Shebangs (#!/usr/bin/env php)
 * - UTF-8 BOM (\uFEFF)
 */
function detectPHPType(content: string): "pure" | "html-mixed" {
  // Regex to find the first PHP open tag, ignoring shebangs, whitespace, and BOM.
  // It checks for <?php (case-insensitive), <?=, or <? (short tag)
  const phpTagRegex = /^(?:\s*|#!\/.*?\n|\uFEFF)*<\?(?:php|=)?/i;
  const match = content.match(phpTagRegex);

  if (!match) {
    // No PHP tags found at the beginning - treat as HTML-mixed
    return "html-mixed";
  }

  // If the match occurs at or near the beginning (after only whitespace/shebang/BOM),
  // it's a pure PHP file
  return "pure";
}

/**
 * Sanitize PHP signature (exclude body, limit to first 200 characters)
 */
function sanitizePHPSignature(node: PHPNode, content: string): string {
  const nodeText = content.substring(node.startIndex, node.endIndex);
  // 関数本体（{...}）を除外
  const bodyIndex = nodeText.indexOf("{");
  const signatureText = bodyIndex >= 0 ? nodeText.substring(0, bodyIndex) : nodeText;
  // 最初の200文字に制限し、1行に圧縮
  const truncated = signatureText.substring(0, 200);
  return truncated.split(/\r?\n/)[0]?.trim().replace(/\s+/g, " ") ?? "";
}

/**
 * PHPDocコメント（/＊＊ ＊/）を抽出
 */
function getPHPDocComment(node: PHPNode, content: string): string | null {
  const parent = node.parent;
  if (!parent) return null;

  // 親ノードのすべての子から、このノードの直前にあるコメントを探す
  const precedingComments: string[] = [];
  const siblings = parent.children;
  const nodeIndex = siblings.indexOf(node);

  // このノードより前の兄弟を逆順で調べる
  for (let i = nodeIndex - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (!sibling) continue;

    // commentをチェック
    if (sibling.type === "comment") {
      const commentText = content.substring(sibling.startIndex, sibling.endIndex);
      // /** */ 形式のPHPDocコメントのみ抽出
      if (commentText.startsWith("/**") && commentText.endsWith("*/")) {
        const cleanedComment = commentText
          .replace(/^\/\*\*\s?|\s?\*\/$/g, "")
          .replace(/^\s*\*\s?/gm, "")
          .trim();
        precedingComments.unshift(cleanedComment);
      }
    } else if (sibling.type !== "text" && !sibling.text.trim().match(/^\s*$/)) {
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
function toPHPLineNumber(position: Parser.Point): number {
  return position.row + 1;
}

/**
 * PHPのシンボルレコードを作成
 */
function createPHPSymbolRecords(tree: Parser.Tree, content: string): SymbolRecord[] {
  const results: Array<Omit<SymbolRecord, "symbolId">> = [];

  /**
   * 子ノードから名前を抽出
   */
  function extractName(node: PHPNode): string | null {
    function findName(n: PHPNode): PHPNode | null {
      if (n.type === "name") {
        return n;
      }
      for (const child of n.namedChildren) {
        const found = findName(child);
        if (found) return found;
      }
      return null;
    }

    const nameNode = findName(node);
    return nameNode ? content.substring(nameNode.startIndex, nameNode.endIndex) : null;
  }

  /**
   * ツリーを再帰的にトラバースしてシンボルを抽出
   */
  function visit(node: PHPNode): void {
    // class_declaration: クラス宣言
    if (node.type === "class_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "class",
          rangeStartLine: toPHPLineNumber(node.startPosition),
          rangeEndLine: toPHPLineNumber(node.endPosition),
          signature: sanitizePHPSignature(node, content),
          doc: getPHPDocComment(node, content),
        });
      }
    }
    // interface_declaration: インターフェース宣言
    else if (node.type === "interface_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "interface",
          rangeStartLine: toPHPLineNumber(node.startPosition),
          rangeEndLine: toPHPLineNumber(node.endPosition),
          signature: sanitizePHPSignature(node, content),
          doc: getPHPDocComment(node, content),
        });
      }
    }
    // trait_declaration: トレイト宣言
    else if (node.type === "trait_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "trait",
          rangeStartLine: toPHPLineNumber(node.startPosition),
          rangeEndLine: toPHPLineNumber(node.endPosition),
          signature: sanitizePHPSignature(node, content),
          doc: getPHPDocComment(node, content),
        });
      }
    }
    // function_definition: トップレベル関数またはメソッド
    else if (node.type === "function_definition" || node.type === "method_declaration") {
      const name = extractName(node);
      if (name) {
        // 親がclass_declaration/trait_declaration/interface_declarationの子孫の場合はmethod、それ以外はfunction
        let isMethod = false;
        let parentNode = node.parent;
        while (parentNode) {
          if (
            parentNode.type === "class_declaration" ||
            parentNode.type === "trait_declaration" ||
            parentNode.type === "interface_declaration"
          ) {
            isMethod = true;
            break;
          }
          parentNode = parentNode.parent;
        }
        const kind = isMethod ? "method" : "function";
        results.push({
          name,
          kind,
          rangeStartLine: toPHPLineNumber(node.startPosition),
          rangeEndLine: toPHPLineNumber(node.endPosition),
          signature: sanitizePHPSignature(node, content),
          doc: getPHPDocComment(node, content),
        });
      }
    }
    // property_declaration: プロパティ
    else if (node.type === "property_declaration") {
      // property_element から変数名を抽出
      const propertyElement = node.namedChildren.find((child) => child.type === "property_element");
      if (propertyElement) {
        const variableNameNode = propertyElement.namedChildren.find(
          (child) => child.type === "variable_name"
        );
        if (variableNameNode) {
          const name = content
            .substring(variableNameNode.startIndex, variableNameNode.endIndex)
            .replace(/^\$/, ""); // $を除去
          results.push({
            name,
            kind: "property",
            rangeStartLine: toPHPLineNumber(node.startPosition),
            rangeEndLine: toPHPLineNumber(node.endPosition),
            signature: sanitizePHPSignature(node, content),
            doc: getPHPDocComment(node, content),
          });
        }
      }
    }
    // const_declaration: 定数（クラス定数）
    else if (node.type === "const_declaration") {
      const constElement = node.namedChildren.find((child) => child.type === "const_element");
      if (constElement) {
        const name = extractName(constElement);
        if (name) {
          results.push({
            name,
            kind: "constant",
            rangeStartLine: toPHPLineNumber(node.startPosition),
            rangeEndLine: toPHPLineNumber(node.endPosition),
            signature: sanitizePHPSignature(node, content),
            doc: getPHPDocComment(node, content),
          });
        }
      }
    }
    // namespace_definition: 名前空間
    else if (node.type === "namespace_definition") {
      const namespaceName = node.namedChildren.find((child) => child.type === "namespace_name");
      if (namespaceName) {
        const name = content.substring(namespaceName.startIndex, namespaceName.endIndex);
        results.push({
          name,
          kind: "namespace",
          rangeStartLine: toPHPLineNumber(node.startPosition),
          rangeEndLine: toPHPLineNumber(node.endPosition),
          signature: sanitizePHPSignature(node, content),
          doc: getPHPDocComment(node, content),
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

/**
 * PHPのuse文を解析して依存関係を収集
 */
function collectPHPDependencies(
  sourcePath: string,
  tree: Parser.Tree,
  content: string,
  _fileSet: Set<string>
): DependencyRecord[] {
  const dependencies = new Map<string, DependencyRecord>();

  const record = (kind: "path" | "package", dst: string) => {
    const key = `${kind}:${dst}`;
    if (!dependencies.has(key)) {
      dependencies.set(key, { dstKind: kind, dst, rel: "import" });
    }
  };

  function visit(node: PHPNode): void {
    // namespace_use_declaration: use文
    if (node.type === "namespace_use_declaration") {
      // namespace_use_clauseを探す（通常のuse文）
      const useClauses = node.namedChildren.filter(
        (child) => child.type === "namespace_use_clause"
      );
      for (const useClause of useClauses) {
        // qualified_nameまたはnameを抽出
        const qualifiedName = useClause.namedChildren.find(
          (child) => child.type === "qualified_name" || child.type === "name"
        );
        if (qualifiedName) {
          const importName = content.substring(qualifiedName.startIndex, qualifiedName.endIndex);
          // Treat all namespaced imports as packages until composer.json parsing is implemented.
          // PSR-4 maps namespace prefixes to base directories (e.g., App\ -> src/),
          // not relative paths from the current file's directory.
          // TODO: Implement proper PSR-4 resolution by parsing composer.json
          record("package", importName);
        }
      }

      // namespace_use_groupを探す（グループ化されたuse文: use Foo\{Bar, Baz};）
      const useGroups = node.namedChildren.filter((child) => child.type === "namespace_use_group");
      if (useGroups.length > 0) {
        // プレフィックスを取得（例: App\Services）
        const prefixNode = node.namedChildren.find((child) => child.type === "namespace_name");
        const prefix = prefixNode
          ? content.substring(prefixNode.startIndex, prefixNode.endIndex)
          : "";

        for (const useGroup of useGroups) {
          // namespace_use_group_clauseを処理
          const groupClauses = useGroup.namedChildren.filter(
            (child) => child.type === "namespace_use_group_clause"
          );
          for (const groupClause of groupClauses) {
            const namespaceName = groupClause.namedChildren.find(
              (child) => child.type === "namespace_name" || child.type === "name"
            );
            if (namespaceName) {
              const suffix = content.substring(namespaceName.startIndex, namespaceName.endIndex);
              const fullName = prefix ? `${prefix}\\${suffix}` : suffix;
              // Treat all namespaced imports as packages (same reasoning as above)
              record("package", fullName);
            }
          }
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

// ========================================
// Java analyzer helpers
// ========================================

type JavaNode = Parser.SyntaxNode;

/**
 * Javaのシグネチャをサニタイズ（本体を除外し、最初の200文字に制限）
 */
function sanitizeJavaSignature(node: JavaNode, content: string): string {
  const nodeText = content.substring(node.startIndex, node.endIndex);
  // メソッド本体（{...}）を除外
  const bodyIndex = nodeText.indexOf("{");
  const signatureText = bodyIndex >= 0 ? nodeText.substring(0, bodyIndex) : nodeText;
  // 改行を空白に置き換えて1行に圧縮してから200文字に制限
  // （先に改行処理することで、複数行シグネチャの情報が失われるのを防ぐ）
  const normalized = signatureText.replace(/\s+/g, " ").trim();
  return normalized.substring(0, 200);
}

/**
 * Javadocコメント（/＊＊ ＊/）を抽出
 */
function getJavaDocComment(node: JavaNode, content: string): string | null {
  const parent = node.parent;
  if (!parent) return null;

  // 親ノードのすべての子から、このノードの直前にあるコメントを探す
  const precedingComments: string[] = [];
  const siblings = parent.children;
  const nodeIndex = siblings.indexOf(node);

  // このノードより前の兄弟を逆順で調べる
  for (let i = nodeIndex - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (!sibling) continue;

    // block_commentをチェック
    if (sibling.type === "block_comment") {
      const commentText = content.substring(sibling.startIndex, sibling.endIndex);
      // /** */ 形式のJavadocコメントのみ抽出
      if (commentText.startsWith("/**") && commentText.endsWith("*/")) {
        const cleanedComment = commentText
          .replace(/^\/\*\*\s?|\s?\*\/$/g, "")
          .replace(/^\s*\*\s?/gm, "")
          .trim();
        precedingComments.unshift(cleanedComment);
      }
    } else if (!sibling.text.trim().match(/^\s*$/)) {
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
function toJavaLineNumber(position: Parser.Point): number {
  return position.row + 1;
}

/**
 * Javaのシンボルレコードを作成
 */
function createJavaSymbolRecords(tree: Parser.Tree, content: string): SymbolRecord[] {
  const results: Array<Omit<SymbolRecord, "symbolId">> = [];

  /**
   * 子ノードから識別子名を抽出
   */
  function extractName(node: JavaNode): string | null {
    const identifierNode = node.namedChildren.find((child) => child.type === "identifier");
    return identifierNode
      ? content.substring(identifierNode.startIndex, identifierNode.endIndex)
      : null;
  }

  /**
   * ツリーを再帰的にトラバースしてシンボルを抽出
   */
  function visit(node: JavaNode): void {
    // class_declaration: クラス宣言
    if (node.type === "class_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "class",
          rangeStartLine: toJavaLineNumber(node.startPosition),
          rangeEndLine: toJavaLineNumber(node.endPosition),
          signature: sanitizeJavaSignature(node, content),
          doc: getJavaDocComment(node, content),
        });
      }
    }

    // interface_declaration: インターフェース宣言
    if (node.type === "interface_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "interface",
          rangeStartLine: toJavaLineNumber(node.startPosition),
          rangeEndLine: toJavaLineNumber(node.endPosition),
          signature: sanitizeJavaSignature(node, content),
          doc: getJavaDocComment(node, content),
        });
      }
    }

    // enum_declaration: 列挙型宣言
    if (node.type === "enum_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "enum",
          rangeStartLine: toJavaLineNumber(node.startPosition),
          rangeEndLine: toJavaLineNumber(node.endPosition),
          signature: sanitizeJavaSignature(node, content),
          doc: getJavaDocComment(node, content),
        });
      }
    }

    // annotation_type_declaration: アノテーション型宣言
    if (node.type === "annotation_type_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "annotation",
          rangeStartLine: toJavaLineNumber(node.startPosition),
          rangeEndLine: toJavaLineNumber(node.endPosition),
          signature: sanitizeJavaSignature(node, content),
          doc: getJavaDocComment(node, content),
        });
      }
    }

    // field_declaration: フィールド宣言
    if (node.type === "field_declaration") {
      // variable_declaratorから変数名を抽出
      const declarators = node.namedChildren.filter(
        (child) => child.type === "variable_declarator"
      );
      for (const declarator of declarators) {
        const name = extractName(declarator);
        if (name) {
          results.push({
            name,
            kind: "field",
            rangeStartLine: toJavaLineNumber(node.startPosition),
            rangeEndLine: toJavaLineNumber(node.endPosition),
            signature: sanitizeJavaSignature(node, content),
            doc: getJavaDocComment(node, content),
          });
        }
      }
    }

    // constructor_declaration: コンストラクタ宣言
    if (node.type === "constructor_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "constructor",
          rangeStartLine: toJavaLineNumber(node.startPosition),
          rangeEndLine: toJavaLineNumber(node.endPosition),
          signature: sanitizeJavaSignature(node, content),
          doc: getJavaDocComment(node, content),
        });
      }
    }

    // method_declaration: メソッド宣言
    if (node.type === "method_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "method",
          rangeStartLine: toJavaLineNumber(node.startPosition),
          rangeEndLine: toJavaLineNumber(node.endPosition),
          signature: sanitizeJavaSignature(node, content),
          doc: getJavaDocComment(node, content),
        });
      }
    }

    // annotation_type_element_declaration: アノテーション内のメソッド宣言
    if (node.type === "annotation_type_element_declaration") {
      const name = extractName(node);
      if (name) {
        results.push({
          name,
          kind: "method",
          rangeStartLine: toJavaLineNumber(node.startPosition),
          rangeEndLine: toJavaLineNumber(node.endPosition),
          signature: sanitizeJavaSignature(node, content),
          doc: getJavaDocComment(node, content),
        });
      }
    }

    // 子ノードを再帰的に訪問
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);

  // symbolIdを割り当て
  return results
    .sort((a, b) => a.rangeStartLine - b.rangeStartLine)
    .map((item, index) => ({ symbolId: index + 1, ...item }));
}

/**
 * Javaのimport文を解析して依存関係を収集
 */
function collectJavaDependencies(
  _sourcePath: string,
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

  function visit(node: JavaNode): void {
    // import_declaration: import文
    if (node.type === "import_declaration") {
      // scoped_identifier または identifier を探す
      const identifierNode = node.namedChildren.find(
        (child) => child.type === "scoped_identifier" || child.type === "identifier"
      );
      if (identifierNode) {
        let importName = content.substring(identifierNode.startIndex, identifierNode.endIndex);

        // ワイルドカードインポートのチェック (import java.util.*)
        // asteriskノードを探す
        const hasAsterisk = node.namedChildren.some((child) => child.type === "asterisk");
        if (hasAsterisk) {
          importName += ".*";
        }

        // ローカルファイル判定: com.example.MyClass -> com/example/MyClass.java
        // ワイルドカードの場合はパッケージとして扱う
        let kind: "path" | "package" = "package";
        if (!hasAsterisk) {
          const filePath = importName.replace(/\./g, "/") + ".java";

          // Maven/Gradle標準構造のプレフィックスを除去して完全一致でチェック
          // これにより、同名ファイルが異なるパッケージに存在する場合も正確に解決できる
          const matchingFile = Array.from(fileSet).find((f) => {
            // 標準的なソースディレクトリプレフィックスを除去
            const normalizedPath = f
              .replace(/^src\/main\/java\//, "")
              .replace(/^src\/test\/java\//, "")
              .replace(/^src\//, "");

            return normalizedPath === filePath;
          });

          kind = matchingFile ? "path" : "package";
        }

        record(kind, importName);
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

export async function analyzeSource(
  pathInRepo: string,
  lang: string | null,
  content: string,
  fileSet: Set<string>,
  workspaceRoot?: string
): Promise<AnalysisResult> {
  const normalizedLang = lang ?? "";
  if (!SUPPORTED_LANGUAGES.has(normalizedLang)) {
    return { symbols: [], snippets: [], dependencies: [] };
  }

  // Dart language: use Analysis Server
  if (normalizedLang === "Dart") {
    if (!workspaceRoot) {
      console.warn(
        `[analyzeSource] workspaceRoot required for Dart analysis, skipping ${pathInRepo}`
      );
      return { symbols: [], snippets: [], dependencies: [] };
    }
    return await analyzeDartSource(pathInRepo, content, workspaceRoot);
  }

  // PHP language: use tree-sitter
  if (normalizedLang === "PHP") {
    try {
      // Create new parser instance for each file (thread-safety for concurrent processing)
      const parser = new Parser();

      // tree-sitter-php provides two parsers:
      // - php_only: for pure PHP files (<?php at start)
      // - php: for HTML-mixed PHP files (HTML with <?php ... ?> tags)
      const phpType = detectPHPType(content);
      const language = phpType === "html-mixed" ? PHP_MIXED : PHP_ONLY;

      // Validate language object before setting it
      if (!language || typeof language !== "object") {
        throw new Error(`Tree-sitter language for PHP type "${phpType}" is invalid or undefined`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parser.setLanguage(language as any);
      const tree = parser.parse(content);
      const symbols = createPHPSymbolRecords(tree, content);

      const snippets: SnippetRecord[] = symbols.map((symbol) => ({
        startLine: symbol.rangeStartLine,
        endLine: symbol.rangeEndLine,
        symbolId: symbol.symbolId,
      }));

      const dependencies = collectPHPDependencies(pathInRepo, tree, content, fileSet);

      return { symbols, snippets, dependencies };
    } catch (error) {
      // パース失敗時は空の結果を返して他のファイルの処理を継続
      console.error(`Failed to parse PHP file ${pathInRepo}:`, error);
      return { symbols: [], snippets: [], dependencies: [] };
    }
  }

  // Java言語の場合、tree-sitterを使用
  if (normalizedLang === "Java") {
    try {
      // 各ファイルごとに新しいパーサーインスタンスを作成（並行処理の安全性のため）
      const parser = new Parser();

      // Validate language object before setting it
      if (!Java || typeof Java !== "object") {
        throw new Error("Tree-sitter language for Java is invalid or undefined");
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parser.setLanguage(Java as any);
      const tree = parser.parse(content);
      const symbols = createJavaSymbolRecords(tree, content);

      const snippets: SnippetRecord[] = symbols.map((symbol) => ({
        startLine: symbol.rangeStartLine,
        endLine: symbol.rangeEndLine,
        symbolId: symbol.symbolId,
      }));

      const dependencies = collectJavaDependencies(pathInRepo, tree, content, fileSet);

      return { symbols, snippets, dependencies };
    } catch (error) {
      // パース失敗時は空の結果を返して他のファイルの処理を継続
      console.error(`Failed to parse Java file ${pathInRepo}:`, error);
      return { symbols: [], snippets: [], dependencies: [] };
    }
  }

  // Swift言語の場合、tree-sitterを使用
  if (normalizedLang === "Swift") {
    try {
      // 各ファイルごとに新しいパーサーインスタンスを作成（並行処理の安全性のため）
      const parser = new Parser();

      // Validate language object before setting it
      if (!Swift || typeof Swift !== "object") {
        throw new Error("Tree-sitter language for Swift is invalid or undefined");
      }

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
