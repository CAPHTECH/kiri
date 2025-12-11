/**
 * MCP Prompts機能のためのプロンプト定義とテンプレート生成
 *
 * MCP仕様: https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

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
    description: "エラーメッセージから関連コードを検索",
    arguments: [
      {
        name: "error_message",
        required: true,
        description: "エラーメッセージ",
      },
    ],
  },
  {
    name: "find-tests",
    description: "指定ファイルのテストを検索",
    arguments: [
      {
        name: "file_path",
        required: true,
        description: "ファイルパス",
      },
    ],
  },
  {
    name: "explain-function",
    description: "関数の実装と使用箇所を検索",
    arguments: [
      {
        name: "function_name",
        required: true,
        description: "関数名",
      },
    ],
  },
  {
    name: "find-implementations",
    description: "インターフェースや型の実装を検索",
    arguments: [
      {
        name: "type_name",
        required: true,
        description: "型名",
      },
    ],
  },
  {
    name: "trace-dependency",
    description: "ファイルの依存関係をトレース",
    arguments: [
      {
        name: "file_path",
        required: true,
        description: "起点ファイルパス",
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
    return `以下のエラーメッセージに関連するコードを検索してください。

## エラーメッセージ
\`\`\`
${errorMessage}
\`\`\`

## 検索手順
1. \`context_bundle\` を使用してエラーメッセージ内のキーワード（関数名、ファイル名、クラス名等）で検索
2. 関連するスタックトレース情報があれば、該当ファイルを \`snippets_get\` で確認
3. エラーの原因となりそうなコードを特定

## 期待する出力
- エラーの原因箇所の特定
- 修正案の提示`;
  },

  "find-tests": (args) => {
    const filePath = args.file_path ?? "";
    return `以下のファイルに対応するテストファイルを検索してください。

## 対象ファイル
\`${filePath}\`

## 検索手順
1. \`files_search\` を使用して対象ファイル名に基づくテストファイルを検索
   - 例: \`foo.ts\` → \`foo.spec.ts\`, \`foo.test.ts\`, \`__tests__/foo.ts\`
2. テストファイルが見つかったら \`snippets_get\` で内容を確認
3. \`deps_closure\` で対象ファイルの依存関係も確認し、関連テストを特定

## 期待する出力
- テストファイルのパス一覧
- テストカバレッジの概要（テストされている関数/メソッド）`;
  },

  "explain-function": (args) => {
    const functionName = args.function_name ?? "";
    return `以下の関数の実装と使用箇所を検索して説明してください。

## 関数名
\`${functionName}\`

## 検索手順
1. \`context_bundle\` を使用して関数定義を検索
2. \`snippets_get\` で関数の完全な実装を取得
3. \`files_search\` または \`deps_closure\` (direction: inbound) で使用箇所を特定

## 期待する出力
- 関数のシグネチャと実装の説明
- 主要な使用箇所
- 依存関係（呼び出している他の関数）`;
  },

  "find-implementations": (args) => {
    const typeName = args.type_name ?? "";
    return `以下のインターフェース/型の実装を検索してください。

## 型名
\`${typeName}\`

## 検索手順
1. \`context_bundle\` を使用して型定義を検索
2. \`files_search\` で "implements ${typeName}" や "extends ${typeName}" を検索
3. 各実装クラス/オブジェクトの概要を \`snippets_get\` で確認

## 期待する出力
- 型定義の場所と内容
- 実装一覧（クラス名、ファイルパス）
- 各実装の特徴や違い`;
  },

  "trace-dependency": (args) => {
    const filePath = args.file_path ?? "";
    const direction = args.direction ?? "both";
    return `以下のファイルの依存関係をトレースしてください。

## 起点ファイル
\`${filePath}\`

## 方向
${direction === "both" ? "双方向（inbound + outbound）" : direction}

## 検索手順
1. \`deps_closure\` を使用して依存関係を取得
   ${direction === "both" ? "- direction: outbound（このファイルが使用するモジュール）\n   - direction: inbound（このファイルを使用するモジュール）" : `- direction: ${direction}`}
2. 重要な依存関係について \`snippets_get\` で詳細を確認

## 期待する出力
- 依存グラフの概要
- 主要な依存関係の説明
- 循環依存の有無`;
  },
};

// =============================================================================
// カスタムプロンプト読み込み
// =============================================================================

/**
 * ファイルが存在するかチェック
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * .kiri/prompts.yaml からカスタムプロンプトを読み込む
 *
 * @param repoRoot - リポジトリのルートパス
 * @returns カスタムプロンプト定義の配列
 */
export async function loadCustomPrompts(repoRoot: string): Promise<CustomPromptDefinition[]> {
  const configPath = path.join(repoRoot, ".kiri", "prompts.yaml");

  if (!(await fileExists(configPath))) {
    return [];
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const config = parseYaml(content) as PromptsConfig;
    return config.prompts ?? [];
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
