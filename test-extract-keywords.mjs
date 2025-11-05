// Test extractKeywords to see what it actually extracts
// We'll manually implement the extraction functions to test

process.env.KIRI_TOKENIZATION_STRATEGY = 'phrase-aware';

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "should", "could", "may", "might", "can", "must", "shall",
  "this", "that", "these", "those", "i", "you", "he", "she", "it",
  "we", "they", "them", "their", "what", "which", "who", "when",
  "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "can",
  "just", "get", "set", "let", "var", "const", "function",
  "return", "if", "else", "elif", "end", "then", "while",
]);

function extractCompoundTerms(text) {
  const compoundPattern = /(?:^|\s|[^\p{L}\p{N}_-])([\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+)(?=\s|[^\p{L}\p{N}_-]|$)/giu;
  const matches = Array.from(text.matchAll(compoundPattern)).map((m) => m[1]);
  return matches
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

function tokenizeText(text) {
  // phrase-aware mode
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function extractRegularWords(text) {
  const words = tokenizeText(text).filter(
    (word) => word.length >= 3 && !STOP_WORDS.has(word)
  );
  return words;
}

// Simplified extraction (skip quotes and path segments for this test)
function extractKeywords(text) {
  const result = {
    phrases: [],
    keywords: [],
  };

  // Phase 3: Extract compound terms
  const compoundTerms = extractCompoundTerms(text);
  console.log('Phase 3 - Compound terms:', compoundTerms);
  result.phrases.push(...compoundTerms);

  // Phase 4: Extract regular words
  const regularWords = extractRegularWords(text);
  console.log('Phase 4 - Regular words:', regularWords);

  // Deduplication
  for (const word of regularWords) {
    if (!result.keywords.includes(word) && !result.phrases.includes(word)) {
      result.keywords.push(word);
    }
  }

  return result;
}

// Test cases
console.log('='.repeat(70));
console.log('Test 1: user_profile management implementation');
console.log('='.repeat(70));
const result1 = extractKeywords('user_profile management implementation');
console.log('Final result:');
console.log('  phrases:', result1.phrases);
console.log('  keywords:', result1.keywords);

console.log('\n' + '='.repeat(70));
console.log('Test 2: page-agent Lambda handler');
console.log('='.repeat(70));
const result2 = extractKeywords('page-agent Lambda handler');
console.log('Final result:');
console.log('  phrases:', result2.phrases);
console.log('  keywords:', result2.keywords);

console.log('\n' + '='.repeat(70));
console.log('Test 3: file_embedding vector generation');
console.log('='.repeat(70));
const result3 = extractKeywords('file_embedding vector generation');
console.log('Final result:');
console.log('  phrases:', result3.phrases);
console.log('  keywords:', result3.keywords);
