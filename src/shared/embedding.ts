import { createHash } from "node:crypto";

import { tokenizeText } from "./tokenizer.js";

export interface EmbeddingVector {
  dims: number;
  values: number[];
}

const DEFAULT_DIMS = 64;

function hashToken(token: string): number {
  const digest = createHash("sha256").update(token).digest();
  // Use the first four bytes to build a deterministic integer hash
  const byte0 = digest[0] ?? 0;
  const byte1 = digest[1] ?? 0;
  const byte2 = digest[2] ?? 0;
  const byte3 = digest[3] ?? 0;
  return ((byte0 << 24) | (byte1 << 16) | (byte2 << 8) | byte3) >>> 0;
}

function applyToken(vector: number[], token: string): void {
  const hash = hashToken(token);
  const index = hash % vector.length;
  const sign = (hash & 1) === 0 ? 1 : -1;
  const weight = Math.log(1 + token.length);
  const current = vector[index];
  if (current !== undefined) {
    vector[index] = current + sign * weight;
  }
}

function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    return values.map(() => 0);
  }
  return values.map((value) => value / norm);
}

export function generateEmbedding(text: string, dims = DEFAULT_DIMS): EmbeddingVector | null {
  if (!text || text.trim().length === 0) {
    return null;
  }
  const tokens = tokenizeText(text);
  if (tokens.length === 0) {
    return null;
  }
  const vector = new Array<number>(dims).fill(0);
  for (const token of tokens) {
    applyToken(vector, token);
  }
  return { dims, values: normalize(vector) };
}

/**
 * Calculate structural similarity between two embedding vectors using cosine similarity.
 * Note: This measures syntactic/structural similarity based on LSH (Locality-Sensitive Hashing),
 * not semantic similarity from language models like BERT or GPT embeddings.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Similarity score between 0 and 1
 */
export function structuralSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const valueA = a[i];
    const valueB = b[i];
    if (valueA === undefined || valueB === undefined) {
      continue;
    }
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}

/** @deprecated Use structuralSimilarity() instead. Kept for backward compatibility. */
export const cosineSimilarity = structuralSimilarity;

export const EMBEDDING_DIMS = DEFAULT_DIMS;
