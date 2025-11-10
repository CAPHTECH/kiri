/**
 * Test helpers and mocks for Dart Analysis Server tests
 */

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

/**
 * Mock ChildProcess for Analysis Server tests
 */
export class MockChildProcess extends EventEmitter implements Partial<ChildProcess> {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed = false;
  pid = 12345;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.handleInput(chunk.toString());
        callback();
      },
    });
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  /**
   * Handle input from test (requests sent to Analysis Server)
   */
  private handleInput(_data: string): void {
    // テスト側でオーバーライド可能
  }

  /**
   * Simulate server sending a message
   */
  sendMessage(message: object): void {
    const line = JSON.stringify(message) + "\n";
    this.stdout.push(line);
  }

  /**
   * Simulate server error
   */
  sendError(error: string): void {
    this.stderr.push(error + "\n");
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.emit("exit", 0, signal);
    return true;
  }
}

/**
 * Create mock response for analysis.getOutline
 */
export function createMockOutlineResponse(outlineData: object): object {
  return {
    id: "1",
    result: {
      outline: outlineData,
    },
  };
}

/**
 * Create mock Dart SDK info
 */
export function createMockSdkInfo() {
  return {
    sdkPath: "/mock/dart-sdk",
    version: "3.2.0",
    analysisServerPath: "/mock/dart-sdk/bin/snapshots/analysis_server.dart.snapshot",
    dartExecutable: "/mock/dart-sdk/bin/dart", // Windows fix: absolute path for spawn
  };
}
