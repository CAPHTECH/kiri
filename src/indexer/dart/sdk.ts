/**
 * Dart SDK detection and validation utilities
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Fix #6: SDK detection timeout (default: 5000ms)
const SDK_DETECT_TIMEOUT_MS = parseInt(process.env.DART_SDK_DETECT_TIMEOUT_MS ?? "5000", 10);

export interface DartSdkInfo {
  sdkPath: string;
  version: string;
  analysisServerPath: string;
  dartExecutable: string; // dart 実行ファイルの絶対パス（Windows対応）
}

/**
 * MissingToolError: Dart SDKが見つからない場合のエラー
 */
export class MissingToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingToolError";
  }
}

/**
 * Dart SDKの検出と検証
 *
 * 検出順序:
 * 1. DART_SDK 環境変数
 * 2. PATH から dart コマンド検索
 *
 * @returns DartSdkInfo
 * @throws MissingToolError - Dart SDKが見つからない場合
 */
export function detectDartSdk(): DartSdkInfo {
  // Windows判定
  const isWindows = process.platform === "win32";
  const dartExeName = isWindows ? "dart.exe" : "dart";

  // 1. DART_SDK 環境変数をチェック
  const dartSdkEnv = process.env.DART_SDK;
  if (dartSdkEnv) {
    const dartPath = path.join(dartSdkEnv, "bin", dartExeName);
    const snapshotPath = path.join(dartSdkEnv, "bin", "snapshots", "analysis_server.dart.snapshot");

    if (existsSync(snapshotPath) && existsSync(dartPath)) {
      const version = getDartVersion(dartPath);
      return {
        sdkPath: dartSdkEnv,
        version,
        analysisServerPath: snapshotPath,
        dartExecutable: dartPath,
      };
    }
  }

  // 2. PATH から dart コマンドを検索（プラットフォーム別）
  // Fix #6: Use spawnSync with timeout to prevent hanging on network issues
  try {
    const whichCmd = isWindows ? "where" : "which";
    const result = spawnSync(whichCmd, ["dart"], {
      encoding: "utf-8",
      timeout: SDK_DETECT_TIMEOUT_MS,
      killSignal: isWindows ? "SIGTERM" : "SIGKILL",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      // Command failed (dart not found in PATH)
      throw new Error(`${whichCmd} dart failed with status ${result.status}`);
    }

    const dartPathOutput = (result.stdout || "").trim();
    // where は複数行返す可能性があるので最初の行を使用
    const dartPath = dartPathOutput.split("\n")[0]?.trim();

    if (dartPath && existsSync(dartPath)) {
      const version = getDartVersion(dartPath);
      // dart コマンドから SDK パスを推測
      // 通常 /path/to/dart-sdk/bin/dart なので bin の親ディレクトリ
      const sdkPath = path.dirname(path.dirname(dartPath));

      // Fix #2: Flutter SDK support - try multiple snapshot locations
      // Flutter wrapper: <flutter>/bin/dart → snapshot at <flutter>/bin/cache/dart-sdk/bin/snapshots/
      // Standalone SDK: <dart-sdk>/bin/dart → snapshot at <dart-sdk>/bin/snapshots/
      const snapshotCandidates = [
        path.join(sdkPath, "bin", "snapshots", "analysis_server.dart.snapshot"),
        path.join(
          sdkPath,
          "bin",
          "cache",
          "dart-sdk",
          "bin",
          "snapshots",
          "analysis_server.dart.snapshot"
        ),
      ];

      for (const snapshotPath of snapshotCandidates) {
        if (existsSync(snapshotPath)) {
          // Flutter SDKの場合はactual SDK pathを調整
          const actualSdkPath = snapshotPath.includes(path.join("cache", "dart-sdk"))
            ? path.join(sdkPath, "bin", "cache", "dart-sdk")
            : sdkPath;

          return {
            sdkPath: actualSdkPath,
            version,
            analysisServerPath: snapshotPath,
            dartExecutable: dartPath,
          };
        }
      }
    }
  } catch {
    // which/where dart が失敗した場合は次へ
  }

  // Dart SDK が見つからない
  throw new MissingToolError(
    "Dart SDK not found. Please install Dart SDK and ensure 'dart' is in PATH, or set DART_SDK environment variable. Visit https://dart.dev/get-dart for installation instructions."
  );
}

/**
 * dart --version の実行結果からバージョン文字列を取得
 *
 * @param dartExecutable - dart 実行ファイルのパス
 * @returns バージョン文字列（例: "3.2.0"）
 */
function getDartVersion(dartExecutable: string): string {
  // Fix #6: Use spawnSync with timeout to prevent hanging
  const isWindows = process.platform === "win32";
  const result = spawnSync(dartExecutable, ["--version"], {
    encoding: "utf-8",
    timeout: SDK_DETECT_TIMEOUT_MS,
    killSignal: isWindows ? "SIGTERM" : "SIGKILL",
  });

  // Check stdout first, then stderr (dart --version outputs to stderr)
  const output = result.stdout || result.stderr || "";
  const match = output.match(/Dart SDK version:\s+(\S+)/);

  if (match?.[1]) {
    return match[1];
  }

  // If timeout or other error occurred, log it
  if (result.error || result.signal) {
    console.warn(
      `[getDartVersion] Failed to get version: error=${result.error?.message}, signal=${result.signal}`
    );
  }

  return "unknown";
}

// Fix #5: SDK検出結果をメモ化（大量ファイル処理時の性能改善）
// Fix #25 (Codex Critical Review Round 4): Don't cache failures permanently - allow retries
let cachedSdkAvailable: boolean | null = null;
let cacheTimestamp: number = 0;
const CACHE_FAILURE_TTL_MS = 60000; // Re-check failed detection after 60 seconds

/**
 * Dart SDK が利用可能かチェック（throws しない版）
 *
 * Fix #5: 結果をメモ化して複数回の子プロセス生成を防ぐ
 * Fix #25: 失敗時は一定時間後に再検証を許可（一時的な環境問題からの回復を可能にする）
 *
 * @returns SDK が利用可能な場合 true
 */
export function isDartSdkAvailable(): boolean {
  const now = Date.now();

  // Success cache is永続的（環境が変わらない限り有効）
  if (cachedSdkAvailable === true) {
    return true;
  }

  // Failure cache has TTL - retry after expiration
  if (cachedSdkAvailable === false && now - cacheTimestamp < CACHE_FAILURE_TTL_MS) {
    return false;
  }

  try {
    detectDartSdk();
    cachedSdkAvailable = true;
    cacheTimestamp = now;
    return true;
  } catch {
    cachedSdkAvailable = false;
    cacheTimestamp = now;
    return false;
  }
}

/**
 * SDK検出キャッシュを無効化（テスト用）
 */
export function invalidateSdkCache(): void {
  cachedSdkAvailable = null;
}
