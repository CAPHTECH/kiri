import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

// Inline version of isInGitRepository for debugging
async function isInGitRepository(dirPath) {
  console.log('  🔍 Checking if in Git repo:', dirPath);
  let currentPath = dirPath;
  const root = dirname(currentPath);

  while (currentPath !== root) {
    const gitPath = join(currentPath, ".git");
    console.log('    Checking:', gitPath);
    try {
      await access(gitPath);
      console.log('    ✅ Found .git at:', gitPath);
      return true;
    } catch {
      console.log('    ❌ Not found, going up...');
    }
    currentPath = dirname(currentPath);
  }

  console.log('  ❌ No .git found in hierarchy');
  return false;
}

async function createGitignoreIfNeeded(dirPath) {
  console.log('  📝 Attempting to create .gitignore in:', dirPath);
  const gitignorePath = join(dirPath, ".gitignore");

  try {
    await access(gitignorePath);
    console.log('  ⏭️  .gitignore already exists, skipping');
  } catch {
    console.log('  ✍️  Creating .gitignore at:', gitignorePath);
    const content =
      "# This directory is managed by the application's database client.\n" +
      "# All files in this directory are ignored to prevent committing database files.\n" +
      "*\n";
    await writeFile(gitignorePath, content, "utf-8");
    console.log('  ✅ .gitignore created');
  }
}

async function testDebug() {
  console.log('🧪 Debug Test: Auto-.gitignore\n');

  const repoDir = await mkdtemp(join(tmpdir(), 'kiri-debug-'));
  console.log('📁 Test directory:', repoDir);

  try {
    // Initialize git repo
    console.log('\n1️⃣ Initializing git repo...');
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    console.log('✅ Git repo initialized');

    // Create data directory
    const dataDir = join(repoDir, 'data');
    console.log('\n2️⃣ Creating data directory:', dataDir);
    await mkdir(dataDir, { recursive: true });
    console.log('✅ Data directory created');

    // Check if in Git repo
    console.log('\n3️⃣ Checking if data directory is in Git repo...');
    const isInGit = await isInGitRepository(dataDir);
    console.log('Result:', isInGit ? '✅ IN GIT' : '❌ NOT IN GIT');

    // Create .gitignore
    if (isInGit) {
      console.log('\n4️⃣ Creating .gitignore...');
      await createGitignoreIfNeeded(dataDir);
    }

    // Verify
    console.log('\n5️⃣ Verifying .gitignore...');
    const gitignorePath = join(dataDir, '.gitignore');
    try {
      await access(gitignorePath);
      console.log('✅ .gitignore exists');
    } catch {
      console.log('❌ .gitignore does NOT exist');
    }

  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

testDebug().catch(console.error);
