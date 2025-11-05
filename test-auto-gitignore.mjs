import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { DuckDBClient } from './dist/src/shared/duckdb.js';

async function testAutoGitignore() {
  console.log('🧪 Testing Auto-.gitignore Feature\n');
  console.log('='.repeat(80));

  // Test 1: In Git repository with autoGitignore: true (default)
  console.log('\n📋 Test 1: Inside Git repo, autoGitignore=true (default)');
  console.log('-'.repeat(80));

  const repoDir = await mkdtemp(join(tmpdir(), 'kiri-git-test-'));
  try {
    // Initialize git repo
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });

    const dbPath = join(repoDir, 'data', 'test.duckdb');
    console.log('📁 Creating database at:', dbPath);

    const db = await DuckDBClient.connect({
      databasePath: dbPath,
      ensureDirectory: true,
      // autoGitignore: true is the default
    });

    const gitignorePath = join(repoDir, 'data', '.gitignore');
    try {
      const content = await readFile(gitignorePath, 'utf-8');
      console.log('✅ .gitignore created successfully');
      console.log('📄 Content:');
      console.log(content);
    } catch (error) {
      console.log('❌ .gitignore NOT created');
      console.error(error);
    }

    await db.close();
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }

  // Test 2: Outside Git repository
  console.log('\n📋 Test 2: Outside Git repo (no .git directory)');
  console.log('-'.repeat(80));

  const nonGitDir = await mkdtemp(join(tmpdir(), 'kiri-nongit-test-'));
  try {
    const dbPath = join(nonGitDir, 'data', 'test.duckdb');
    console.log('📁 Creating database at:', dbPath);

    const db = await DuckDBClient.connect({
      databasePath: dbPath,
      ensureDirectory: true,
    });

    const gitignorePath = join(nonGitDir, 'data', '.gitignore');
    try {
      await readFile(gitignorePath, 'utf-8');
      console.log('❌ .gitignore created (should NOT be created outside Git repo)');
    } catch {
      console.log('✅ .gitignore NOT created (correct behavior outside Git repo)');
    }

    await db.close();
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
  }

  // Test 3: With autoGitignore: false
  console.log('\n📋 Test 3: Inside Git repo, autoGitignore=false');
  console.log('-'.repeat(80));

  const repoDir2 = await mkdtemp(join(tmpdir(), 'kiri-git-test2-'));
  try {
    execSync('git init', { cwd: repoDir2, stdio: 'ignore' });

    const dbPath = join(repoDir2, 'data', 'test.duckdb');
    console.log('📁 Creating database at:', dbPath);

    const db = await DuckDBClient.connect({
      databasePath: dbPath,
      ensureDirectory: true,
      autoGitignore: false,
    });

    const gitignorePath = join(repoDir2, 'data', '.gitignore');
    try {
      await readFile(gitignorePath, 'utf-8');
      console.log('❌ .gitignore created (should NOT be created when autoGitignore=false)');
    } catch {
      console.log('✅ .gitignore NOT created (correct behavior with autoGitignore=false)');
    }

    await db.close();
  } finally {
    await rm(repoDir2, { recursive: true, force: true });
  }

  // Test 4: Existing .gitignore should not be overwritten
  console.log('\n📋 Test 4: Existing .gitignore should be preserved');
  console.log('-'.repeat(80));

  const repoDir3 = await mkdtemp(join(tmpdir(), 'kiri-git-test3-'));
  try {
    execSync('git init', { cwd: repoDir3, stdio: 'ignore' });

    const dataDir = join(repoDir3, 'data');
    await mkdir(dataDir, { recursive: true });

    const gitignorePath = join(dataDir, '.gitignore');
    const existingContent = '# My custom gitignore\n!important.db\n';
    await import('node:fs/promises').then(fs => fs.writeFile(gitignorePath, existingContent, 'utf-8'));

    const dbPath = join(dataDir, 'test.duckdb');
    console.log('📁 Creating database at:', dbPath);
    console.log('📄 Pre-existing .gitignore content:');
    console.log(existingContent);

    const db = await DuckDBClient.connect({
      databasePath: dbPath,
      ensureDirectory: true,
    });

    const content = await readFile(gitignorePath, 'utf-8');
    if (content === existingContent) {
      console.log('✅ Existing .gitignore preserved (not overwritten)');
    } else {
      console.log('❌ Existing .gitignore was modified');
      console.log('📄 New content:');
      console.log(content);
    }

    await db.close();
  } finally {
    await rm(repoDir3, { recursive: true, force: true });
  }

  // Test 5: Test in kiri's own var/ directory (real-world scenario)
  console.log('\n📋 Test 5: Real-world test in var/ directory');
  console.log('-'.repeat(80));

  const varDbPath = join(process.cwd(), 'var', 'test-auto-gitignore.duckdb');
  console.log('📁 Creating database at:', varDbPath);

  const db = await DuckDBClient.connect({
    databasePath: varDbPath,
    ensureDirectory: true,
  });

  const varGitignorePath = join(process.cwd(), 'var', '.gitignore');
  try {
    const content = await readFile(varGitignorePath, 'utf-8');
    console.log('✅ .gitignore created in var/');
    console.log('📄 Content:');
    console.log(content);
  } catch {
    console.log('ℹ️  .gitignore NOT created in var/ (may already exist or var/ is gitignored)');
  }

  await db.close();

  console.log('\n' + '='.repeat(80));
  console.log('✅ All tests completed');
  console.log('='.repeat(80));
}

testAutoGitignore().catch(console.error);
