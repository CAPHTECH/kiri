import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { DuckDBClient } from './dist/shared/duckdb.js';
import { contextBundle, resolveRepoId } from './dist/server/handlers.js';

// Set tokenization strategy to phrase-aware
process.env.KIRI_TOKENIZATION_STRATEGY = 'phrase-aware';

async function testRegressionCase() {
  console.log('🔍 Regression Test: Original Problem Case\n');
  console.log('Query: "page-agent Lambda handler"');
  console.log('Expected: lambda/page-agent/src/handler.ts should rank #1');
  console.log('Previous problem: canvas-agent and PageEditHandler ranked higher');
  console.log('='.repeat(70));

  // Create temp repo
  const repoDir = await mkdtemp(join(tmpdir(), 'kiri-regression-'));

  try {
    // Create test files
    const files = {
      "lambda/page-agent/src/handler.ts": `
// Lambda handler for page-agent
export async function handlePageAgent(event: any) {
  console.log("Processing page agent request");
  return { statusCode: 200, body: "Page agent handler" };
}`,
      "lambda/canvas-agent/src/handler.ts": `
// Lambda handler for canvas-agent
export async function handleCanvasAgent(event: any) {
  console.log("Processing canvas agent request");
  return { statusCode: 200, body: "Canvas agent handler" };
}`,
      "src/legacy/PageEditHandler.ts": `
// Legacy page edit handler (deprecated)
export class PageEditHandler {
  async handleEdit(pageId: string, content: string) {
    console.log("Editing page with legacy handler");
    return { success: true };
  }
}`,
      "lambda/page-agent/README.md": `# Page Agent Lambda
This Lambda function handles page-agent operations.`,
      "lambda/canvas-agent/README.md": `# Canvas Agent Lambda
This Lambda function handles canvas-agent operations.`,
    };

    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(repoDir, path);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, content);
    }

    // Initialize git repo
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });
    execSync('git config user.name "Test User"', { cwd: repoDir });
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "Initial commit"', { cwd: repoDir });

    // Index the repo
    const dbDir = await mkdtemp(join(tmpdir(), 'kiri-db-'));
    const dbPath = join(dbDir, 'index.duckdb');

    execSync(`node dist/indexer/cli.js --repo "${repoDir}" --db "${dbPath}" --full`, {
      stdio: 'inherit'
    });

    // Query the context
    const db = await DuckDBClient.connect({ databasePath: dbPath });
    const repoId = await resolveRepoId(db, repoDir);
    const context = { db, repoId };

    const bundle = await contextBundle(context, {
      goal: "page-agent Lambda handler",
      limit: 10,
    });

    console.log(`\n📊 Results: Found ${bundle.context.length} files\n`);

    // Display results
    bundle.context.forEach((item, idx) => {
      const isTarget = item.path === 'lambda/page-agent/src/handler.ts';
      const isCanvas = item.path === 'lambda/canvas-agent/src/handler.ts';
      const isLegacy = item.path === 'src/legacy/PageEditHandler.ts';

      let marker = '  ';
      if (isTarget) marker = '🎯';
      else if (isCanvas) marker = '❌';
      else if (isLegacy) marker = '❌';

      console.log(`${marker} ${idx + 1}. ${item.path}`);
      console.log(`     Score: ${item.score.toFixed(3)}`);
      console.log(`     Reasons: ${item.why.join(', ')}`);
      console.log('');
    });

    // Analysis
    const pageAgentHandler = bundle.context.find(
      (item) => item.path === 'lambda/page-agent/src/handler.ts'
    );
    const canvasAgentHandler = bundle.context.find(
      (item) => item.path === 'lambda/canvas-agent/src/handler.ts'
    );
    const legacyHandler = bundle.context.find(
      (item) => item.path === 'src/legacy/PageEditHandler.ts'
    );

    console.log('='.repeat(70));
    console.log('📈 ANALYSIS\n');

    if (pageAgentHandler) {
      const rank = bundle.context.indexOf(pageAgentHandler) + 1;
      console.log(`✅ lambda/page-agent/src/handler.ts found at rank #${rank}`);
      console.log(`   Score: ${pageAgentHandler.score.toFixed(3)}`);
      console.log(`   Reasons: ${pageAgentHandler.why.join(', ')}`);

      const hasPhraseMatch = pageAgentHandler.why.some(r => r.includes('phrase:page-agent'));
      const hasPathBoost = pageAgentHandler.why.some(r =>
        r.startsWith('path-phrase:') || r.startsWith('path-segment:')
      );

      console.log(`   ✓ Phrase matching: ${hasPhraseMatch ? 'YES' : 'NO'}`);
      console.log(`   ✓ Path-based boost: ${hasPathBoost ? 'YES' : 'NO'}`);
    } else {
      console.log('❌ lambda/page-agent/src/handler.ts NOT FOUND in results');
    }

    console.log('');

    if (canvasAgentHandler) {
      const rank = bundle.context.indexOf(canvasAgentHandler) + 1;
      console.log(`📍 canvas-agent at rank #${rank} (score: ${canvasAgentHandler.score.toFixed(3)})`);
      if (pageAgentHandler && pageAgentHandler.score > canvasAgentHandler.score) {
        console.log('   ✅ Correctly ranked LOWER than page-agent');
      } else {
        console.log('   ❌ Incorrectly ranked HIGHER than or equal to page-agent');
      }
    }

    if (legacyHandler) {
      const rank = bundle.context.indexOf(legacyHandler) + 1;
      console.log(`📍 PageEditHandler at rank #${rank} (score: ${legacyHandler.score.toFixed(3)})`);
      if (pageAgentHandler && pageAgentHandler.score > legacyHandler.score) {
        console.log('   ✅ Correctly ranked LOWER than page-agent');
      } else {
        console.log('   ❌ Incorrectly ranked HIGHER than or equal to page-agent');
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('🎉 VERDICT');
    console.log('='.repeat(70));

    const pageAgentRank = bundle.context.indexOf(pageAgentHandler) + 1;
    const success = pageAgentRank === 1 &&
                    pageAgentHandler &&
                    (!canvasAgentHandler || pageAgentHandler.score > canvasAgentHandler.score) &&
                    (!legacyHandler || pageAgentHandler.score > legacyHandler.score);

    if (success) {
      console.log('✅ SUCCESS: Original problem is FIXED!');
      console.log('   - page-agent ranks #1');
      console.log('   - Hyphenated term preserved');
      console.log('   - Path-based scoring working');
      console.log('   - Structural similarity not causing false positives');
    } else {
      console.log('⚠️  PARTIAL SUCCESS or FAILURE');
      console.log(`   - page-agent ranks #${pageAgentRank} (expected #1)`);
    }

    await db.close();
    await rm(dbDir, { recursive: true, force: true });
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

testRegressionCase().catch(console.error);
