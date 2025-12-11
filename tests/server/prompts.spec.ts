/**
 * MCP Prompts機能のテスト
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  PRESET_PROMPTS,
  generatePromptMessages,
  listPrompts,
  loadCustomPrompts,
} from "../../src/server/prompts.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("MCP Prompts", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  // ==========================================================================
  // PRESET_PROMPTS
  // ==========================================================================

  describe("PRESET_PROMPTS", () => {
    it("should have 5 preset prompts", () => {
      expect(PRESET_PROMPTS).toHaveLength(5);
    });

    it("should include debug-error prompt", () => {
      const prompt = PRESET_PROMPTS.find((p) => p.name === "debug-error");
      expect(prompt).toBeDefined();
      expect(prompt?.description).toBe("Search for related code from an error message");
      expect(prompt?.arguments).toHaveLength(1);
      expect(prompt?.arguments?.[0]?.name).toBe("error_message");
      expect(prompt?.arguments?.[0]?.required).toBe(true);
    });

    it("should include find-tests prompt", () => {
      const prompt = PRESET_PROMPTS.find((p) => p.name === "find-tests");
      expect(prompt).toBeDefined();
      expect(prompt?.arguments?.[0]?.name).toBe("file_path");
    });

    it("should include explain-function prompt", () => {
      const prompt = PRESET_PROMPTS.find((p) => p.name === "explain-function");
      expect(prompt).toBeDefined();
      expect(prompt?.arguments?.[0]?.name).toBe("function_name");
    });

    it("should include find-implementations prompt", () => {
      const prompt = PRESET_PROMPTS.find((p) => p.name === "find-implementations");
      expect(prompt).toBeDefined();
      expect(prompt?.arguments?.[0]?.name).toBe("type_name");
    });

    it("should include trace-dependency prompt", () => {
      const prompt = PRESET_PROMPTS.find((p) => p.name === "trace-dependency");
      expect(prompt).toBeDefined();
      expect(prompt?.arguments).toHaveLength(2);
      expect(prompt?.arguments?.[0]?.name).toBe("file_path");
      expect(prompt?.arguments?.[1]?.name).toBe("direction");
    });
  });

  // ==========================================================================
  // listPrompts
  // ==========================================================================

  describe("listPrompts", () => {
    it("should return preset prompts when no custom prompts exist", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      const prompts = await listPrompts(tempDir);

      expect(prompts).toHaveLength(5);
      expect(prompts.map((p) => p.name)).toContain("debug-error");
      expect(prompts.map((p) => p.name)).toContain("find-tests");
    });

    it("should merge custom prompts with presets", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      // カスタムプロンプトを作成
      await mkdir(join(tempDir, ".kiri"), { recursive: true });
      await writeFile(
        join(tempDir, ".kiri", "prompts.yaml"),
        `prompts:
  - name: "custom-review"
    description: "カスタムコードレビュー"
    arguments:
      - name: "file_path"
        required: true
        description: "レビュー対象ファイル"
    template: |
      以下のファイルをレビュー: \${file_path}
`
      );

      const prompts = await listPrompts(tempDir);

      // プリセット5 + カスタム1 = 6
      expect(prompts).toHaveLength(6);
      expect(prompts.map((p) => p.name)).toContain("custom-review");
    });

    it("should override preset prompts with custom prompts of same name", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      // プリセットと同名のカスタムプロンプトを作成
      await mkdir(join(tempDir, ".kiri"), { recursive: true });
      await writeFile(
        join(tempDir, ".kiri", "prompts.yaml"),
        `prompts:
  - name: "debug-error"
    description: "カスタムデバッグエラー"
    arguments:
      - name: "error_message"
        required: true
    template: "カスタムテンプレート: \${error_message}"
`
      );

      const prompts = await listPrompts(tempDir);

      // プリセット4（debug-error除外） + カスタム1 = 5
      expect(prompts).toHaveLength(5);

      const debugError = prompts.find((p) => p.name === "debug-error");
      expect(debugError?.description).toBe("カスタムデバッグエラー");
    });
  });

  // ==========================================================================
  // loadCustomPrompts
  // ==========================================================================

  describe("loadCustomPrompts", () => {
    it("should return empty array when .kiri/prompts.yaml does not exist", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      const customPrompts = await loadCustomPrompts(tempDir);
      expect(customPrompts).toEqual([]);
    });

    it("should parse valid YAML prompts config", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await mkdir(join(tempDir, ".kiri"), { recursive: true });
      await writeFile(
        join(tempDir, ".kiri", "prompts.yaml"),
        `prompts:
  - name: "test-prompt"
    description: "テストプロンプト"
    template: "テスト"
`
      );

      const customPrompts = await loadCustomPrompts(tempDir);
      expect(customPrompts).toHaveLength(1);
      expect(customPrompts[0]?.name).toBe("test-prompt");
      expect(customPrompts[0]?.description).toBe("テストプロンプト");
    });

    it("should return empty array for invalid YAML", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await mkdir(join(tempDir, ".kiri"), { recursive: true });
      await writeFile(join(tempDir, ".kiri", "prompts.yaml"), "invalid: yaml: content:");

      const customPrompts = await loadCustomPrompts(tempDir);
      expect(customPrompts).toEqual([]);
    });
  });

  // ==========================================================================
  // generatePromptMessages
  // ==========================================================================

  describe("generatePromptMessages", () => {
    it("should generate messages for preset prompts", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      const result = await generatePromptMessages(
        "debug-error",
        { error_message: "ReferenceError: foo is not defined" },
        tempDir
      );

      expect(result).not.toBeNull();
      expect(result?.description).toBe("Search for related code from an error message");
      expect(result?.messages).toHaveLength(1);
      expect(result?.messages[0]?.role).toBe("user");
      expect(result?.messages[0]?.content.type).toBe("text");
      expect(result?.messages[0]?.content.text).toContain("ReferenceError: foo is not defined");
    });

    it("should generate messages for custom prompts", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await mkdir(join(tempDir, ".kiri"), { recursive: true });
      await writeFile(
        join(tempDir, ".kiri", "prompts.yaml"),
        `prompts:
  - name: "custom-prompt"
    description: "カスタムプロンプト"
    template: "ファイル: \${file_path}, 目的: \${purpose}"
`
      );

      const result = await generatePromptMessages(
        "custom-prompt",
        { file_path: "src/app.ts", purpose: "レビュー" },
        tempDir
      );

      expect(result).not.toBeNull();
      expect(result?.description).toBe("カスタムプロンプト");
      expect(result?.messages[0]?.content.text).toBe("ファイル: src/app.ts, 目的: レビュー");
    });

    it("should return null for unknown prompts", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      const result = await generatePromptMessages("nonexistent-prompt", {}, tempDir);
      expect(result).toBeNull();
    });

    it("should expand template variables correctly", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      const result = await generatePromptMessages(
        "trace-dependency",
        { file_path: "src/index.ts", direction: "outbound" },
        tempDir
      );

      expect(result?.messages[0]?.content.text).toContain("src/index.ts");
      expect(result?.messages[0]?.content.text).toContain("outbound");
    });

    it("should handle missing template variables gracefully", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-prompts-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await mkdir(join(tempDir, ".kiri"), { recursive: true });
      await writeFile(
        join(tempDir, ".kiri", "prompts.yaml"),
        `prompts:
  - name: "test"
    template: "Value: \${missing_var}"
`
      );

      const result = await generatePromptMessages("test", {}, tempDir);
      expect(result?.messages[0]?.content.text).toBe("Value: ");
    });
  });
});
