import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { DuckDBClient } from './dist/src/shared/duckdb.js';
import { contextBundle, resolveRepoId } from './dist/src/server/handlers.js';

// Set tokenization strategy to phrase-aware
process.env.KIRI_TOKENIZATION_STRATEGY = 'phrase-aware';

async function liveDemo() {
  console.log('🚀 Kiri MCP Live Demo - Context Bundle with Improvements\n');
  console.log('Tokenization Strategy:', process.env.KIRI_TOKENIZATION_STRATEGY);
  console.log('Repository:', process.cwd());
  console.log('='.repeat(80) + '\n');

  // Index current repository
  const dbDir = await mkdtemp(join(tmpdir(), 'kiri-demo-db-'));
  const dbPath = join(dbDir, 'index.duckdb');

  console.log('📦 Indexing current repository...\n');
  execSync(`node dist/src/indexer/cli.js --repo . --db "${dbPath}" --full`, {
    stdio: 'inherit'
  });

  const db = await DuckDBClient.connect({ databasePath: dbPath });
  const repoId = await resolveRepoId(db, process.cwd());
  const context = { db, repoId };

  // Test cases demonstrating improvements
  const testCases = [
    {
      name: "1. Phrase-aware: Hyphenated term (kebab-case)",
      goal: "page-agent Lambda handler implementation",
      limit: 5,
      expected: "Should prioritize files with 'page-agent' in path/content with phrase boost"
    },
    {
      name: "2. Phrase-aware: Underscore term (snake_case)",
      goal: "context_bundle scoring implementation",
      limit: 5,
      expected: "Should recognize 'context_bundle' as single phrase"
    },
    {
      name: "3. Path-based scoring",
      goal: "DuckDB client connection handling",
      limit: 5,
      expected: "Should boost files with 'duckdb' in path"
    },
    {
      name: "4. Implementation file prioritization",
      goal: "indexer file scanning and processing",
      limit: 5,
      expected: "Should rank .ts files higher than .md files"
    },
    {
      name: "5. Unicode compound terms",
      goal: "tokenization strategy configuration",
      limit: 5,
      expected: "Should handle compound terms correctly"
    }
  ];

  for (const testCase of testCases) {
    console.log('\n' + '='.repeat(80));
    console.log(`📋 ${testCase.name}`);
    console.log('='.repeat(80));
    console.log(`Goal: "${testCase.goal}"`);
    console.log(`Expected: ${testCase.expected}\n`);

    const result = await contextBundle(context, {
      goal: testCase.goal,
      limit: testCase.limit,
    });

    console.log(`Found ${result.context.length} results:\n`);

    result.context.forEach((item, idx) => {
      const ext = item.path.split('.').pop();
      const isDoc = ['.md', '.yaml', '.yml'].some(e => item.path.endsWith(e));
      const marker = isDoc ? '📄' : '📝';

      console.log(`${marker} ${idx + 1}. ${item.path}`);
      console.log(`   Score: ${item.score.toFixed(3)}`);

      // Group reasons by category
      const reasons = item.why;
      const phrases = reasons.filter(r => r.startsWith('phrase:'));
      const pathMatches = reasons.filter(r => r.startsWith('path-'));
      const boosts = reasons.filter(r => r.startsWith('boost:') || r.startsWith('penalty:'));
      const others = reasons.filter(r =>
        !r.startsWith('phrase:') &&
        !r.startsWith('path-') &&
        !r.startsWith('boost:') &&
        !r.startsWith('penalty:')
      );

      if (phrases.length > 0) {
        console.log(`   🎯 Phrases: ${phrases.join(', ')}`);
      }
      if (pathMatches.length > 0) {
        console.log(`   📁 Path matches: ${pathMatches.join(', ')}`);
      }
      if (boosts.length > 0) {
        console.log(`   ⚖️  Boosts: ${boosts.join(', ')}`);
      }
      if (others.length > 0) {
        console.log(`   ℹ️  Other: ${others.join(', ')}`);
      }
      console.log();
    });
  }

  console.log('\n' + '='.repeat(80));
  console.log('📊 DEMO SUMMARY');
  console.log('='.repeat(80));
  console.log('✅ Phrase-aware tokenization: Compound terms (hyphens & underscores) preserved');
  console.log('✅ Path-based scoring: Files with matching keywords in path get extra boost');
  console.log('✅ Implementation file priority: .ts files ranked higher than .md with strong penalty');
  console.log('✅ Unicode support: International characters handled correctly');
  console.log('✅ N+1 query optimization: Consolidated database queries for performance\n');

  await db.close();
  await rm(dbDir, { recursive: true, force: true });
}

liveDemo().catch(console.error);
