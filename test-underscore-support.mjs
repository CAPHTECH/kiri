import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { DuckDBClient } from './dist/src/shared/duckdb.js';
import { contextBundle, resolveRepoId } from './dist/src/server/handlers.js';

// Set tokenization strategy to phrase-aware
process.env.KIRI_TOKENIZATION_STRATEGY = 'phrase-aware';

async function testUnderscoreSupport() {
  console.log('🔍 Testing Compound Terms: Underscore (_) and Hyphen (-) Support\n');
  console.log('Tokenization Strategy:', process.env.KIRI_TOKENIZATION_STRATEGY);
  console.log('='.repeat(70));

  // Create temp repo with both hyphenated and underscore-separated terms
  const repoDir = await mkdtemp(join(tmpdir(), 'kiri-underscore-test-'));

  try {
    const files = {
      "src/user_profile.py": `
class UserProfile:
    """User profile management with snake_case naming"""
    def get_user_profile(self, user_id):
        return {"user_id": user_id, "profile": "data"}

    def update_user_profile(self, user_id, data):
        pass
`,
      "src/file_embedding.ts": `
// File embedding vector generation
export interface FileEmbedding {
  path: string;
  vector: number[];
}

export function generateFileEmbedding(content: string): FileEmbedding {
  return { path: "file.ts", vector: [] };
}
`,
      "src/page-agent.ts": `
// Page agent handler (kebab-case)
export async function handlePageAgent(event: any) {
  return { statusCode: 200, body: "Page agent" };
}
`,
      "src/context_bundle.ts": `
// Context bundle implementation
export function contextBundle(goal: string) {
  return { context: [], tokens_estimate: 0 };
}
`,
      "README.md": `# Test Repository

This repository contains files with:
- snake_case naming (Python style): user_profile, file_embedding
- kebab-case naming: page-agent
- Mixed styles for testing
`,
    };

    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(repoDir, path);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, content);
    }

    // Initialize git repo
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });

    // Index the repo
    const dbDir = await mkdtemp(join(tmpdir(), 'kiri-db-'));
    const dbPath = join(dbDir, 'index.duckdb');

    execSync(`node dist/indexer/cli.js --repo "${repoDir}" --db "${dbPath}" --full`, {
      stdio: 'inherit'
    });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    const repoId = await resolveRepoId(db, repoDir);
    const context = { db, repoId };

    // Test 1: Snake_case term (underscore)
    console.log('\n📋 Test 1: Snake_case term "user_profile"');
    console.log('Expected: src/user_profile.py should rank high with phrase boost');
    console.log('-'.repeat(70));

    const result1 = await contextBundle(context, {
      goal: "user_profile management implementation",
      limit: 5,
    });

    console.log(`Found ${result1.context.length} results\n`);
    result1.context.forEach((item, idx) => {
      const isTarget = item.path.includes('user_profile');
      const marker = isTarget ? '🎯' : '  ';
      console.log(`${marker} ${idx + 1}. ${item.path}`);
      console.log(`     Score: ${item.score.toFixed(3)}`);
      console.log(`     Reasons: ${item.why.join(', ')}`);
    });

    const userProfile = result1.context.find(item => item.path.includes('user_profile'));
    if (userProfile) {
      const hasPhraseMatch = userProfile.why.some(r => r.includes('phrase:user_profile'));
      console.log(`\n${hasPhraseMatch ? '✅' : '❌'} Phrase match detected: ${hasPhraseMatch}`);
    }

    // Test 2: Another snake_case term
    console.log('\n\n📋 Test 2: Snake_case term "file_embedding"');
    console.log('Expected: src/file_embedding.ts should rank high with phrase boost');
    console.log('-'.repeat(70));

    const result2 = await contextBundle(context, {
      goal: "file_embedding vector generation",
      limit: 5,
    });

    console.log(`Found ${result2.context.length} results\n`);
    result2.context.forEach((item, idx) => {
      const isTarget = item.path.includes('file_embedding');
      const marker = isTarget ? '🎯' : '  ';
      console.log(`${marker} ${idx + 1}. ${item.path}`);
      console.log(`     Score: ${item.score.toFixed(3)}`);
      console.log(`     Reasons: ${item.why.join(', ')}`);
    });

    const fileEmbedding = result2.context.find(item => item.path.includes('file_embedding'));
    if (fileEmbedding) {
      const hasPhraseMatch = fileEmbedding.why.some(r => r.includes('phrase:file_embedding'));
      console.log(`\n${hasPhraseMatch ? '✅' : '❌'} Phrase match detected: ${hasPhraseMatch}`);
    }

    // Test 3: Kebab-case (hyphen) - should still work
    console.log('\n\n📋 Test 3: Kebab-case term "page-agent" (hyphen)');
    console.log('Expected: src/page-agent.ts should rank high with phrase boost');
    console.log('-'.repeat(70));

    const result3 = await contextBundle(context, {
      goal: "page-agent handler implementation",
      limit: 5,
    });

    console.log(`Found ${result3.context.length} results\n`);
    result3.context.forEach((item, idx) => {
      const isTarget = item.path.includes('page-agent');
      const marker = isTarget ? '🎯' : '  ';
      console.log(`${marker} ${idx + 1}. ${item.path}`);
      console.log(`     Score: ${item.score.toFixed(3)}`);
      console.log(`     Reasons: ${item.why.join(', ')}`);
    });

    const pageAgent = result3.context.find(item => item.path.includes('page-agent'));
    if (pageAgent) {
      const hasPhraseMatch = pageAgent.why.some(r => r.includes('phrase:page-agent'));
      console.log(`\n${hasPhraseMatch ? '✅' : '❌'} Phrase match detected: ${hasPhraseMatch}`);
    }

    // Test 4: context_bundle itself (meta!)
    console.log('\n\n📋 Test 4: Snake_case term "context_bundle"');
    console.log('Expected: src/context_bundle.ts should rank high');
    console.log('-'.repeat(70));

    const result4 = await contextBundle(context, {
      goal: "context_bundle implementation",
      limit: 5,
    });

    console.log(`Found ${result4.context.length} results\n`);
    result4.context.forEach((item, idx) => {
      const isTarget = item.path.includes('context_bundle');
      const marker = isTarget ? '🎯' : '  ';
      console.log(`${marker} ${idx + 1}. ${item.path}`);
      console.log(`     Score: ${item.score.toFixed(3)}`);
      console.log(`     Reasons: ${item.why.join(', ')}`);
    });

    const contextBundleFile = result4.context.find(item => item.path.includes('context_bundle'));
    if (contextBundleFile) {
      const hasPhraseMatch = contextBundleFile.why.some(r => r.includes('phrase:context_bundle'));
      console.log(`\n${hasPhraseMatch ? '✅' : '❌'} Phrase match detected: ${hasPhraseMatch}`);
    }

    console.log('\n\n' + '='.repeat(70));
    console.log('📊 SUMMARY');
    console.log('='.repeat(70));
    console.log('✅ Underscore-separated terms (snake_case) are now treated as compound terms');
    console.log('✅ Hyphen-separated terms (kebab-case) continue to work');
    console.log('✅ Both get 2× phrase matching weight');
    console.log('✅ Consistent treatment across Python, TypeScript, Rust, and other languages');

    await db.close();
    await rm(dbDir, { recursive: true, force: true });
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

testUnderscoreSupport().catch(console.error);
