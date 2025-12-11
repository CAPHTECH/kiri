/**
 * MCP Prompts機能のためのプロンプト定義とテンプレート生成
 *
 * MCP仕様: https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { fileExistsAsync } from "../shared/utils/path.js";

// =============================================================================
// 型定義
// =============================================================================

/**
 * プロンプトの引数定義
 */
export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/**
 * プロンプト記述子（prompts/listで返す形式）
 */
export interface PromptDescriptor {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}

/**
 * プロンプトメッセージのコンテンツ
 */
export interface PromptContent {
  type: "text";
  text: string;
}

/**
 * プロンプトメッセージ（prompts/getで返す形式）
 */
export interface PromptMessage {
  role: "user" | "assistant";
  content: PromptContent;
}

/**
 * prompts/getのレスポンス
 */
export interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
}

/**
 * カスタムプロンプト定義（.kiri/prompts.yaml用）
 */
interface CustomPromptDefinition {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
  template: string;
}

/**
 * .kiri/prompts.yamlのスキーマ
 */
interface PromptsConfig {
  prompts?: CustomPromptDefinition[];
}

// =============================================================================
// プリセットプロンプト定義
// =============================================================================

/**
 * ビルトインのプリセットプロンプト
 */
export const PRESET_PROMPTS: PromptDescriptor[] = [
  {
    name: "debug-error",
    description: "Search for related code from an error message",
    arguments: [
      {
        name: "error_message",
        required: true,
        description: "Error message",
      },
    ],
  },
  {
    name: "find-tests",
    description: "Search for tests for the specified file",
    arguments: [
      {
        name: "file_path",
        required: true,
        description: "File path",
      },
    ],
  },
  {
    name: "explain-function",
    description: "Search for function implementation and usage locations",
    arguments: [
      {
        name: "function_name",
        required: true,
        description: "Function name",
      },
    ],
  },
  {
    name: "find-implementations",
    description: "Search for implementations of an interface or type",
    arguments: [
      {
        name: "type_name",
        required: true,
        description: "Type name",
      },
    ],
  },
  {
    name: "trace-dependency",
    description: "Trace file dependencies",
    arguments: [
      {
        name: "file_path",
        required: true,
        description: "Starting file path",
      },
      {
        name: "direction",
        required: false,
        description: "inbound/outbound (default: both)",
      },
    ],
  },
];

// =============================================================================
// プリセットプロンプトのテンプレート
// =============================================================================

/**
 * プリセットプロンプト名からテンプレートを取得するマップ
 */
const PRESET_TEMPLATES: Record<string, (args: Record<string, string>) => string> = {
  "debug-error": (args) => {
    const errorMessage = args.error_message ?? "";
    return `Please search for code related to the following error message.

## Error Message
\`\`\`
${errorMessage}
\`\`\`

## Search Steps
1. Use \`context_bundle\` to search for keywords in the error message (function names, file names, class names, etc.)
2. If there is related stack trace information, check the relevant files with \`snippets_get\`
3. Identify code that may be causing the error

## Expected Output
- Identification of the error source
- Suggested fixes`;
  },

  "find-tests": (args) => {
    const filePath = args.file_path ?? "";
    return `Please search for test files corresponding to the following file.

## Target File
\`${filePath}\`

## Search Steps
1. Use \`files_search\` to search for test files based on the target file name
   - Example: \`foo.ts\` → \`foo.spec.ts\`, \`foo.test.ts\`, \`__tests__/foo.ts\`
2. Once test files are found, check their contents with \`snippets_get\`
3. Also check the target file's dependencies with \`deps_closure\` to identify related tests

## Expected Output
- List of test file paths
- Test coverage overview (functions/methods being tested)`;
  },

  "explain-function": (args) => {
    const functionName = args.function_name ?? "";
    return `Please search for and explain the implementation and usage locations of the following function.

## Function Name
\`${functionName}\`

## Search Steps
1. Use \`context_bundle\` to search for the function definition
2. Get the complete implementation with \`snippets_get\`
3. Identify usage locations with \`files_search\` or \`deps_closure\` (direction: inbound)

## Expected Output
- Explanation of the function signature and implementation
- Primary usage locations
- Dependencies (other functions being called)`;
  },

  "find-implementations": (args) => {
    const typeName = args.type_name ?? "";
    return `Please search for implementations of the following interface/type.

## Type Name
\`${typeName}\`

## Search Steps
1. Use \`context_bundle\` to search for the type definition
2. Search for "implements ${typeName}" or "extends ${typeName}" with \`files_search\`
3. Check an overview of each implementing class/object with \`snippets_get\`

## Expected Output
- Location and content of the type definition
- List of implementations (class names, file paths)
- Features and differences of each implementation`;
  },

  "trace-dependency": (args) => {
    const filePath = args.file_path ?? "";
    const direction = args.direction ?? "both";
    return `Please trace the dependencies of the following file.

## Starting File
\`${filePath}\`

## Direction
${direction === "both" ? "Bidirectional (inbound + outbound)" : direction}

## Search Steps
1. Use \`deps_closure\` to get dependencies
   ${direction === "both" ? "- direction: outbound (modules this file uses)\n   - direction: inbound (modules that use this file)" : `- direction: ${direction}`}
2. Check details of important dependencies with \`snippets_get\`

## Expected Output
- Overview of the dependency graph
- Explanation of major dependencies
- Presence of circular dependencies`;
  },
};

// =============================================================================
// カスタムプロンプト読み込み
// =============================================================================

/**
 * PromptsConfigの型ガード
 * YAML解析結果が期待する形式かを検証
 */
function isValidPromptsConfig(value: unknown): value is PromptsConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  // prompts が存在しないか、配列であることを確認
  if (obj.prompts === undefined) {
    return true;
  }
  if (!Array.isArray(obj.prompts)) {
    return false;
  }
  // 各プロンプト定義の基本的な検証
  return obj.prompts.every((item: unknown) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const prompt = item as Record<string, unknown>;
    // 必須フィールド: name (string)
    return typeof prompt.name === "string";
  });
}

/**
 * .kiri/prompts.yaml からカスタムプロンプトを読み込む
 *
 * @param repoRoot - リポジトリのルートパス
 * @returns カスタムプロンプト定義の配列
 */
export async function loadCustomPrompts(repoRoot: string): Promise<CustomPromptDefinition[]> {
  const configPath = path.join(repoRoot, ".kiri", "prompts.yaml");

  if (!(await fileExistsAsync(configPath))) {
    return [];
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = parseYaml(content);

    // 型ガードで検証
    if (!isValidPromptsConfig(parsed)) {
      console.warn(
        `Invalid prompts config format in ${configPath}. Expected { prompts: [...] } structure.`
      );
      return [];
    }

    return parsed.prompts ?? [];
  } catch (error) {
    // YAML解析エラー等は警告を出してスキップ
    console.warn(
      `Failed to load custom prompts from ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * カスタムプロンプト定義をPromptDescriptorに変換
 *
 * exactOptionalPropertyTypes対応: undefinedの場合はプロパティ自体を含めない
 */
function customToDescriptor(custom: CustomPromptDefinition): PromptDescriptor {
  const descriptor: PromptDescriptor = {
    name: custom.name,
  };
  if (custom.description !== undefined) {
    descriptor.description = custom.description;
  }
  if (custom.arguments !== undefined) {
    descriptor.arguments = custom.arguments;
  }
  return descriptor;
}

// =============================================================================
// プロンプト一覧取得
// =============================================================================

/**
 * 利用可能なすべてのプロンプトを取得（プリセット + カスタム）
 *
 * @param repoRoot - リポジトリのルートパス
 * @returns プロンプト記述子の配列
 */
export async function listPrompts(repoRoot: string): Promise<PromptDescriptor[]> {
  const customPrompts = await loadCustomPrompts(repoRoot);
  const customDescriptors = customPrompts.map(customToDescriptor);

  // カスタムプロンプトで同名のものがあればカスタムを優先
  const customNames = new Set(customDescriptors.map((p) => p.name));
  const filteredPresets = PRESET_PROMPTS.filter((p) => !customNames.has(p.name));

  return [...filteredPresets, ...customDescriptors];
}

// =============================================================================
// プロンプトメッセージ生成
// =============================================================================

/**
 * テンプレート内の変数を展開
 *
 * ${variable_name} 形式のプレースホルダーを引数値で置換
 */
function expandTemplate(template: string, args: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, name) => args[name] ?? "");
}

/**
 * プロンプトのメッセージを生成
 *
 * @param promptName - プロンプト名
 * @param args - 引数
 * @param repoRoot - リポジトリのルートパス
 * @returns プロンプトメッセージまたはnull（見つからない場合）
 */
export async function generatePromptMessages(
  promptName: string,
  args: Record<string, string>,
  repoRoot: string
): Promise<PromptGetResult | null> {
  // カスタムプロンプトを優先的にチェック
  const customPrompts = await loadCustomPrompts(repoRoot);
  const customPrompt = customPrompts.find((p) => p.name === promptName);

  if (customPrompt) {
    const text = expandTemplate(customPrompt.template, args);
    const result: PromptGetResult = {
      messages: [
        {
          role: "user",
          content: { type: "text", text },
        },
      ],
    };
    // exactOptionalPropertyTypes対応: undefinedの場合はプロパティ自体を含めない
    if (customPrompt.description !== undefined) {
      result.description = customPrompt.description;
    }
    return result;
  }

  // プリセットプロンプトをチェック
  const presetTemplate = PRESET_TEMPLATES[promptName];
  const presetDescriptor = PRESET_PROMPTS.find((p) => p.name === promptName);

  if (presetTemplate && presetDescriptor) {
    const text = presetTemplate(args);
    const result: PromptGetResult = {
      messages: [
        {
          role: "user",
          content: { type: "text", text },
        },
      ],
    };
    // exactOptionalPropertyTypes対応: undefinedの場合はプロパティ自体を含めない
    if (presetDescriptor.description !== undefined) {
      result.description = presetDescriptor.description;
    }
    return result;
  }

  return null;
}
