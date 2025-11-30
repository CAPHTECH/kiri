#!/usr/bin/env node
/**
 * Shirushi CLI wrapper for document scanning
 *
 * Workaround: shirushi's CLI uses import.meta.url check which fails
 * with symlinked node_modules on macOS due to path canonicalization.
 * This wrapper explicitly calls run() to bypass the check.
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { realpathSync } from 'fs';

// Set up argv for subcommand
process.argv = ['node', 'shirushi', 'scan', ...process.argv.slice(2)];

// Resolve the actual path to shirushi CLI (follows symlinks)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../..');
const shirushiCliPath = realpathSync(
  resolve(projectRoot, 'node_modules/shirushi/dist/cli/index.js')
);

// Dynamic import using file URL to match import.meta.url check
const { run } = await import(`file://${shirushiCliPath}`);
run();
