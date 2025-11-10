/**
 * Dart依存関係解析（Phase 3）
 *
 * Analysis ServerのGetLibraryDependenciesResultからDependencyRecordを生成
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DependencyRecord } from "../codeintel.js";
import type { GetLibraryDependenciesResult } from "./types.js";

/**
 * GetLibraryDependenciesResultからDependencyRecordを生成
 *
 * @param filePath - 解析対象ファイルのパス
 * @param dependenciesResult - Analysis Serverの依存関係情報
 * @param workspaceRoot - ワークスペースルート（相対パス解決用）
 * @returns DependencyRecord配列
 */
export function extractDependencies(
  filePath: string,
  dependenciesResult: GetLibraryDependenciesResult,
  workspaceRoot: string
): DependencyRecord[] {
  const dependencies: DependencyRecord[] = [];
  const seen = new Set<string>();

  // libraries配列から各ライブラリのURIを解析
  for (const libraryPath of dependenciesResult.libraries) {
    const dep = analyzeDependencyUri(libraryPath, filePath, workspaceRoot);
    if (dep) {
      const key = `${dep.dstKind}:${dep.dst}`;
      if (!seen.has(key)) {
        seen.add(key);
        dependencies.push(dep);
      }
    }
  }

  return dependencies;
}

/**
 * 依存関係URIを解析してDependencyRecordを生成
 *
 * Dartの依存関係は以下の形式：
 * - dart:core, dart:async など（SDK）
 * - package:flutter/material.dart など（パッケージ）
 * - file:///path/to/file.dart など（相対パス）
 *
 * @param uri - 依存関係URI
 * @param sourceFilePath - 依存元ファイルのパス
 * @param workspaceRoot - ワークスペースルート
 * @returns DependencyRecord または null
 */
function analyzeDependencyUri(
  uri: string,
  sourceFilePath: string,
  workspaceRoot: string
): DependencyRecord | null {
  // dart: スキーム（SDK）
  if (uri.startsWith("dart:")) {
    return {
      dstKind: "package",
      dst: uri, // dart:core, dart:async など
      rel: "import",
    };
  }

  // package: スキーム（外部パッケージ）
  if (uri.startsWith("package:")) {
    return {
      dstKind: "package",
      dst: uri, // package:flutter/material.dart など
      rel: "import",
    };
  }

  // file: スキーム（ローカルファイル）
  if (uri.startsWith("file:")) {
    try {
      // fileURLToPath を使用してクロスプラットフォーム対応
      // Windows: file:///C:/repo/lib/foo.dart → C:\repo\lib\foo.dart
      // Unix: file:///repo/lib/foo.dart → /repo/lib/foo.dart
      const absolutePath = fileURLToPath(uri);
      const relativePath = path.relative(workspaceRoot, absolutePath);

      // ワークスペース外のファイルは無視（クロスプラットフォーム対応）
      if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
        return {
          dstKind: "path",
          dst: relativePath,
          rel: "import",
        };
      }
    } catch (error) {
      console.warn(`[analyzeDependencyUri] Invalid file URI: ${uri}`, error);
    }
    return null;
  }

  // 相対パス（./lib/foo.dart など）
  if (uri.startsWith("./") || uri.startsWith("../")) {
    const sourceDir = path.dirname(sourceFilePath);
    const absolutePath = path.normalize(path.join(sourceDir, uri));
    const relativePath = path.relative(workspaceRoot, absolutePath);

    // ワークスペース外のファイルは無視（Windows互換のため..を含むかチェック）
    if (relativePath.startsWith("..")) {
      return null;
    }

    return {
      dstKind: "path",
      dst: relativePath,
      rel: "import",
    };
  }

  // その他のURIは無視
  return null;
}
