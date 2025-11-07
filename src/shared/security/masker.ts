export interface MaskingOptions {
  tokens: string[];
  replacement?: string;
  skipKeys?: string[];
}

export interface MaskResult<T> {
  masked: T;
  applied: number;
}

const SECRET_BODY_MIN_LENGTH = 10;
const SECRET_BODY_CHAR_CLASS = "[A-Za-z0-9_\\-+/=]";
const SECRET_BODY_PATTERN = `${SECRET_BODY_CHAR_CLASS}{${SECRET_BODY_MIN_LENGTH},}`;
const WORD_CHAR_CLASS = "[A-Za-z0-9]";

interface TokenMatcher {
  pattern: string;
  flags: string;
}

interface NormalizedMaskingOptions {
  matchers: TokenMatcher[];
  replacement: string;
  skipKeySet?: Set<string>;
}

/**
 * トークンパターンの妥当性を検証してReDoS攻撃を防ぐ
 * @param token 検証対象のトークン文字列
 * @throws パターンが長すぎる、またはネストした量指定子を含む場合
 */
function validateTokenPattern(token: string): void {
  if (token.length > 100) {
    throw new Error("Token pattern exceeds maximum length. Use shorter patterns.");
  }
  // ネストした量指定子による壊滅的バックトラッキングを防ぐ
  if (/(\*|\+|\{)\s*(\*|\+|\{)/.test(token)) {
    throw new Error("Invalid pattern contains nested quantifiers. Simplify the pattern.");
  }
}

function looksLikePrefixToken(token: string): boolean {
  if (!token) {
    return false;
  }
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const lastChar = trimmed.charAt(trimmed.length - 1);
  return /[^A-Za-z0-9]/.test(lastChar);
}

function createTokenMatchers(tokens: string[]): TokenMatcher[] {
  const matchers: TokenMatcher[] = [];
  for (const token of tokens) {
    if (!token) continue;
    validateTokenPattern(token);
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (looksLikePrefixToken(token)) {
      matchers.push({
        pattern: `(?<!${WORD_CHAR_CLASS})${escaped}${SECRET_BODY_PATTERN}`,
        flags: "g",
      });
      continue;
    }
    matchers.push({ pattern: escaped, flags: "g" });
  }
  return matchers;
}

function maskString(input: string, options: NormalizedMaskingOptions): MaskResult<string> {
  if (options.matchers.length === 0) {
    return { masked: input, applied: 0 };
  }
  let applied = 0;
  let output = input;
  for (const matcher of options.matchers) {
    const regex = new RegExp(matcher.pattern, matcher.flags);
    output = output.replace(regex, () => {
      applied += 1;
      return options.replacement;
    });
  }
  return { masked: output, applied };
}

function normalizeOptions(options: MaskingOptions): NormalizedMaskingOptions {
  return {
    matchers: createTokenMatchers(options.tokens),
    replacement: options.replacement ?? "***",
    skipKeySet:
      options.skipKeys && options.skipKeys.length > 0 ? new Set(options.skipKeys) : undefined,
  };
}

function maskValueRecursive(
  value: unknown,
  normalized: NormalizedMaskingOptions
): MaskResult<unknown> {
  if (typeof value === "string") {
    return maskString(value, normalized);
  }
  if (Array.isArray(value)) {
    let applied = 0;
    const maskedArray = value.map((item) => {
      const result = maskValueRecursive(item, normalized);
      applied += result.applied;
      return result.masked;
    });
    return { masked: maskedArray, applied };
  }
  if (value && typeof value === "object") {
    let applied = 0;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (normalized.skipKeySet?.has(key)) {
        return [key, item];
      }
      const result = maskValueRecursive(item, normalized);
      applied += result.applied;
      return [key, result.masked];
    });
    return { masked: Object.fromEntries(entries), applied };
  }
  return { masked: value, applied: 0 };
}

export function maskValue(value: unknown, options: MaskingOptions): MaskResult<unknown> {
  const normalized = normalizeOptions(options);
  return maskValueRecursive(value, normalized);
}
