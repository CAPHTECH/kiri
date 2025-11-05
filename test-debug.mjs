// Debug keyword extraction
process.env.KIRI_TOKENIZATION_STRATEGY = 'phrase-aware';

// Simulate the extraction logic
function extractKeywords(text) {
  // Phase 1: Extract quoted phrases
  const phrases = [];
  const quotePattern = /"([^"]+)"|'([^']+)'/g;
  let match;
  let remaining = text;

  while ((match = quotePattern.exec(text)) !== null) {
    const phrase = (match[1] || match[2] || '').trim().toLowerCase();
    if (phrase.length >= 3) {
      phrases.push(phrase);
    }
    remaining = remaining.replace(match[0], ' ');
  }

  // Phase 2: Extract hyphenated terms
  const hyphenPattern = /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi;
  const hyphenatedTerms = remaining.match(hyphenPattern) || [];
  phrases.push(...hyphenatedTerms.map(t => t.toLowerCase()).filter(t => t.length >= 3));

  // Phase 3: Extract path segments
  const pathPattern = /\b[a-z0-9_-]+(?:\/[a-z0-9_-]+)+\b/gi;
  const pathMatches = remaining.match(pathPattern) || [];
  const pathSegments = [];
  for (const path of pathMatches) {
    const parts = path.toLowerCase().split('/');
    pathSegments.push(...parts.filter(p => p.length >= 3));
  }

  // Phase 4: Extract regular words
  const strategy = process.env.KIRI_TOKENIZATION_STRATEGY?.toLowerCase();
  const splitPattern = strategy === 'legacy' ? /[^a-z0-9_]+/iu : /[^a-z0-9_-]+/iu;
  const words = remaining
    .toLowerCase()
    .split(splitPattern)
    .filter(word => word.length >= 3);

  return {
    phrases,
    pathSegments,
    keywords: words.slice(0, 12)
  };
}

console.log('🔍 Testing Keyword Extraction with Phrase-Aware Mode\n');
console.log('Strategy:', process.env.KIRI_TOKENIZATION_STRATEGY);
console.log('='.repeat(70));

// Test cases
const testCases = [
  'scoring-profiles configuration weights textMatch pathMatch',
  'search-ranking algorithm implementation',
  'page-agent Lambda handler implementation',
  'src/server/handlers.ts contextBundle implementation',
  '"file-embedding" vector generation LSH',
  'lambda/page-agent/src/handler.ts'
];

testCases.forEach((goal, idx) => {
  console.log(`\nTest ${idx + 1}: "${goal}"`);
  console.log('-'.repeat(70));
  const result = extractKeywords(goal);
  console.log('Phrases:', result.phrases);
  console.log('Path Segments:', result.pathSegments);
  console.log('Keywords:', result.keywords);
});

console.log('\n' + '='.repeat(70));
console.log('\n📝 Observations:');
console.log('1. Hyphenated terms like "scoring-profiles" are preserved in phrases');
console.log('2. Path-like strings are parsed into segments');
console.log('3. Regular keywords are extracted separately');
console.log('\nNote: The actual implementation may need to filter these differently!');
