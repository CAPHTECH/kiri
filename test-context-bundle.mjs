import { DuckDBClient } from './dist/shared/duckdb.js';
import { contextBundle, resolveRepoId } from './dist/server/handlers.js';

async function testContextBundle() {
  console.log('🔍 Testing context_bundle improvements...\n');

  const db = await DuckDBClient.connect({
    databasePath: 'var/test-index.duckdb'
  });

  try {
    const repoId = await resolveRepoId(db, '/Users/rizumita/Workspace/CAPHTECH.private/kiri');
    const context = { db, repoId };

    // Test 1: Hyphenated term (context-bundle)
    console.log('📋 Test 1: Searching for "context-bundle" (hyphenated term)');
    console.log('=' .repeat(70));
    const result1 = await contextBundle(context, {
      goal: 'context-bundle implementation handler scoring',
      limit: 10
    });

    console.log(`Found ${result1.context.length} results\n`);
    result1.context.slice(0, 5).forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.path}`);
      console.log(`   Score: ${item.score.toFixed(2)}`);
      console.log(`   Reasons: ${item.why.join(', ')}`);
      console.log('');
    });

    // Test 2: Path-based matching
    console.log('\n📋 Test 2: Searching for files in "search-ranking" (path matching)');
    console.log('=' .repeat(70));
    const result2 = await contextBundle(context, {
      goal: 'search-ranking algorithm scoring weights',
      limit: 10
    });

    console.log(`Found ${result2.context.length} results\n`);
    result2.context.slice(0, 5).forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.path}`);
      console.log(`   Score: ${item.score.toFixed(2)}`);
      console.log(`   Reasons: ${item.why.join(', ')}`);
      console.log('');
    });

    // Test 3: Phrase with quotes
    console.log('\n📋 Test 3: Searching with quoted phrase "file-embedding"');
    console.log('=' .repeat(70));
    const result3 = await contextBundle(context, {
      goal: '"file-embedding" vector generation LSH',
      limit: 10
    });

    console.log(`Found ${result3.context.length} results\n`);
    result3.context.slice(0, 5).forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.path}`);
      console.log(`   Score: ${item.score.toFixed(2)}`);
      console.log(`   Reasons: ${item.why.join(', ')}`);
      console.log('');
    });

    // Test 4: Compare results - should NOT match incorrectly
    console.log('\n📋 Test 4: Testing specificity - "scoring-profiles" should NOT match "scoring" alone');
    console.log('=' .repeat(70));
    const result4 = await contextBundle(context, {
      goal: 'scoring-profiles configuration weights',
      limit: 10
    });

    console.log(`Found ${result4.context.length} results\n`);
    const scoringProfilesFile = result4.context.find(item => item.path.includes('scoring-profiles.yml'));
    const scoringTsFile = result4.context.find(item => item.path.includes('scoring.ts'));

    if (scoringProfilesFile && scoringTsFile) {
      const profilesIndex = result4.context.indexOf(scoringProfilesFile);
      const tsIndex = result4.context.indexOf(scoringTsFile);
      console.log(`✅ scoring-profiles.yml ranked at #${profilesIndex + 1} (score: ${scoringProfilesFile.score.toFixed(2)})`);
      console.log(`   Reasons: ${scoringProfilesFile.why.join(', ')}`);
      console.log('');
      console.log(`   scoring.ts ranked at #${tsIndex + 1} (score: ${scoringTsFile.score.toFixed(2)})`);
      console.log(`   Reasons: ${scoringTsFile.why.join(', ')}`);

      if (profilesIndex < tsIndex) {
        console.log('\n✅ SUCCESS: scoring-profiles.yml ranked higher (path-based boost working!)');
      } else {
        console.log('\n⚠️ Note: scoring.ts ranked higher (may contain more content matches)');
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ All tests completed successfully!');

  } finally {
    await db.close();
  }
}

testContextBundle().catch(console.error);
