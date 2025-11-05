import { readFileSync } from 'node:fs';

// Read the handlers.ts source and extract the functions we need
const handlersSource = readFileSync('src/server/handlers.ts', 'utf-8');

// Test the regex directly
const text = "user_profile management implementation";
console.log('Testing compound term extraction:');
console.log('Input:', text);

// Original broken regex (with \b)
const brokenPattern = /\b[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+\b/giu;
const brokenMatches = text.match(brokenPattern) || [];
console.log('\nBroken regex (with \\b):', brokenMatches);

// Fixed regex (with explicit boundaries)
const fixedPattern = /(?:^|\s|[^\p{L}\p{N}_-])([\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+)(?=\s|[^\p{L}\p{N}_-]|$)/giu;
const fixedMatches = Array.from(text.matchAll(fixedPattern)).map(m => m[1]);
console.log('Fixed regex (explicit boundaries):', fixedMatches);

// Test with page-agent for comparison
const text2 = "page-agent Lambda handler";
console.log('\n\nTesting with hyphen:');
console.log('Input:', text2);

const brokenMatches2 = text2.match(brokenPattern) || [];
console.log('Broken regex (with \\b):', brokenMatches2);

const fixedMatches2 = Array.from(text2.matchAll(fixedPattern)).map(m => m[1]);
console.log('Fixed regex (explicit boundaries):', fixedMatches2);
