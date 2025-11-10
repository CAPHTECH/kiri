/**
 * Tests for config sanitizing functions (src/indexer/dart/config.ts)
 *
 * Fix #17-21 (Codex Critical Review Round 3):
 * 環境変数異常値（NaN、空文字、負数）のテスト
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  parseMaxClients,
  parseClientWaitMs,
  parseIdleTtlMs,
  parseFileQueueTtlMs,
} from "../../../src/indexer/dart/config.js";

describe("Dart config sanitizing", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("parseMaxClients", () => {
    it("returns default value when env var is not set", () => {
      delete process.env.DART_ANALYSIS_MAX_CLIENTS;
      expect(parseMaxClients()).toBe(8);
    });

    it("returns parsed value when env var is valid", () => {
      process.env.DART_ANALYSIS_MAX_CLIENTS = "16";
      expect(parseMaxClients()).toBe(16);
    });

    it("returns default when env var is empty string (NaN)", () => {
      process.env.DART_ANALYSIS_MAX_CLIENTS = "";
      expect(parseMaxClients()).toBe(8);
    });

    it("returns default when env var is non-numeric (NaN)", () => {
      process.env.DART_ANALYSIS_MAX_CLIENTS = "abc";
      expect(parseMaxClients()).toBe(8);
    });

    it("returns default when env var is zero", () => {
      process.env.DART_ANALYSIS_MAX_CLIENTS = "0";
      expect(parseMaxClients()).toBe(8);
    });

    it("returns default when env var is negative", () => {
      process.env.DART_ANALYSIS_MAX_CLIENTS = "-5";
      expect(parseMaxClients()).toBe(8);
    });

    it("returns default when env var is Infinity", () => {
      process.env.DART_ANALYSIS_MAX_CLIENTS = "Infinity";
      expect(parseMaxClients()).toBe(8);
    });
  });

  describe("parseClientWaitMs", () => {
    it("returns default value when env var is not set", () => {
      delete process.env.DART_ANALYSIS_CLIENT_WAIT_MS;
      expect(parseClientWaitMs()).toBe(10000);
    });

    it("returns parsed value when env var is valid", () => {
      process.env.DART_ANALYSIS_CLIENT_WAIT_MS = "30000";
      expect(parseClientWaitMs()).toBe(30000);
    });

    it("returns default when env var is empty string (NaN)", () => {
      process.env.DART_ANALYSIS_CLIENT_WAIT_MS = "";
      expect(parseClientWaitMs()).toBe(10000);
    });

    it("returns default when env var is non-numeric (NaN)", () => {
      process.env.DART_ANALYSIS_CLIENT_WAIT_MS = "invalid";
      expect(parseClientWaitMs()).toBe(10000);
    });

    it("returns default when env var is zero", () => {
      process.env.DART_ANALYSIS_CLIENT_WAIT_MS = "0";
      expect(parseClientWaitMs()).toBe(10000);
    });

    it("returns default when env var is negative", () => {
      process.env.DART_ANALYSIS_CLIENT_WAIT_MS = "-1000";
      expect(parseClientWaitMs()).toBe(10000);
    });
  });

  describe("parseIdleTtlMs", () => {
    it("returns default value when env var is not set", () => {
      delete process.env.DART_ANALYSIS_IDLE_MS;
      expect(parseIdleTtlMs()).toBe(60000);
    });

    it("returns parsed value when env var is valid", () => {
      process.env.DART_ANALYSIS_IDLE_MS = "120000";
      expect(parseIdleTtlMs()).toBe(120000);
    });

    it("returns 0 when env var is 0 (TTL disabled)", () => {
      process.env.DART_ANALYSIS_IDLE_MS = "0";
      expect(parseIdleTtlMs()).toBe(0);
    });

    it("returns default when env var is empty string (NaN)", () => {
      process.env.DART_ANALYSIS_IDLE_MS = "";
      expect(parseIdleTtlMs()).toBe(60000);
    });

    it("returns default when env var is non-numeric (NaN)", () => {
      process.env.DART_ANALYSIS_IDLE_MS = "not-a-number";
      expect(parseIdleTtlMs()).toBe(60000);
    });

    it("returns default when env var is negative", () => {
      process.env.DART_ANALYSIS_IDLE_MS = "-30000";
      expect(parseIdleTtlMs()).toBe(60000);
    });

    it("returns default when env var is Infinity", () => {
      process.env.DART_ANALYSIS_IDLE_MS = "Infinity";
      expect(parseIdleTtlMs()).toBe(60000);
    });
  });

  describe("parseFileQueueTtlMs", () => {
    it("returns default value when env var is not set", () => {
      delete process.env.DART_FILE_QUEUE_TTL_MS;
      expect(parseFileQueueTtlMs()).toBe(30000);
    });

    it("returns parsed value when env var is valid", () => {
      process.env.DART_FILE_QUEUE_TTL_MS = "60000";
      expect(parseFileQueueTtlMs()).toBe(60000);
    });

    it("returns minimum 1000ms when env var is 0 (memory leak prevention)", () => {
      process.env.DART_FILE_QUEUE_TTL_MS = "0";
      expect(parseFileQueueTtlMs()).toBe(1000);
    });

    it("returns minimum 1000ms when env var is below minimum", () => {
      process.env.DART_FILE_QUEUE_TTL_MS = "500";
      expect(parseFileQueueTtlMs()).toBe(1000);
    });

    it("returns default when env var is empty string (NaN)", () => {
      process.env.DART_FILE_QUEUE_TTL_MS = "";
      expect(parseFileQueueTtlMs()).toBe(30000);
    });

    it("returns default when env var is non-numeric (NaN)", () => {
      process.env.DART_FILE_QUEUE_TTL_MS = "bad-value";
      expect(parseFileQueueTtlMs()).toBe(30000);
    });

    it("returns minimum 1000ms when env var is negative", () => {
      process.env.DART_FILE_QUEUE_TTL_MS = "-5000";
      expect(parseFileQueueTtlMs()).toBe(1000);
    });
  });
});
