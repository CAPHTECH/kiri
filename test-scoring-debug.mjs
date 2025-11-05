import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { DuckDBClient } from './dist/src/shared/duckdb.js';
import { contextBundle, resolveRepoId } from './dist/src/server/handlers.js';

async function testScoring() {
  const repoDir = await mkdtemp(join(tmpdir(), 'kiri-score-test-'));

  try {
    const files = {
      "src/app/router.ts": `export function route(path: string) {\n  return { path, component: "Page" };\n}\n`,
      "README.md": `# Routing Guide\n\nThis explains the routing system and navigation patterns.\n`,
      "docs/routing.md": `# URL Patterns\n\nHow to access canvas pages through routing.\n`,
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

    execSync(`node dist/src/indexer/cli.js --repo "${repoDir}" --db "${dbPath}" --full`, {
      stdio: 'inherit'
    });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    const repoId = await resolveRepoId(db, repoDir);
    const context = { db, repoId };

    console.log('🔍 Testing: "Canvas page routing, URL patterns, navigation methods"\n');

    const result = await contextBundle(context, {
      goal: "Canvas page routing, URL patterns, navigation methods",
      limit: 10,
    });

    console.log(`Found ${result.context.length} results:\n`);
    result.context.forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.path}`);
      console.log(`   Score: ${item.score.toFixed(3)}`);
      console.log(`   Reasons: ${item.why.join(', ')}`);
      console.log();
    });

    await db.close();
    await rm(dbDir, { recursive: true, force: true });
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

testScoring().catch(console.error);
