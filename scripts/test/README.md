# KIRI Test Verification Scripts

## Overview

Comprehensive test verification system for KIRI that includes:

- Unit tests (all categories)
- Integration tests
- Dart Analysis Server tests
- MCP tools actual operation tests
- Watch mode functionality tests
- Evaluation tests

## Quick Start

```bash
# Run all tests
pnpm run verify

# Run specific category
pnpm run verify:unit          # Unit tests only
pnpm run verify:dart          # Dart tests only
pnpm run verify:integration   # Integration tests only
pnpm run verify:tools         # MCP tools operation tests
pnpm run verify:watch         # Watch mode tests
pnpm run verify:eval          # Evaluation tests
```

## Advanced Usage

```bash
# Run with options
tsx scripts/test/verify-all.ts --category unit --skip-coverage
tsx scripts/test/verify-all.ts --category all --retry 2 --verbose
```

### Options

- `--category <category>`: Specify test category (unit|dart|integration|tools|watch|eval|all)
- `--retry <number>`: Number of retries on failure (default: 0)
- `--skip-coverage`: Skip coverage reporting
- `--verbose`: Enable verbose output

## Test Categories

### Unit Tests (`pnpm run verify:unit`)

Tests for:

- Indexer components
- Server handlers
- Client utilities
- Daemon functionality
- Shared libraries

**Excludes**: Dart-specific tests (run separately for better isolation)

### Dart Tests (`pnpm run verify:dart`)

Tests for Dart Analysis Server integration:

- Client pool management
- Reference counting
- LRU eviction
- Process lifecycle
- Symbol extraction

**Note**: Runs in isolated mode to avoid process management conflicts

### Integration Tests (`pnpm run verify:integration`)

End-to-end workflow tests:

- Daemon lifecycle
- Security mechanisms
- Multi-component interactions

### MCP Tools Tests (`pnpm run verify:tools`)

**Actual operation tests** for MCP server tools:

- Indexes a test repository
- Starts MCP server on port 9999
- Tests each tool with real requests:
  - `files_search`: Keyword search
  - `context_bundle`: Context extraction
  - `snippets_get`: Code snippet retrieval
  - `deps_closure`: Dependency graph

**Validates**: Tools return valid responses in production-like environment

### Watch Mode Tests (`pnpm run verify:watch`)

Verifies file watch functionality:

- Creates test repository
- Runs initial indexing
- Starts daemon in watch mode
- Modifies files and commits
- Verifies re-indexing detected changes

**Validates**: File changes trigger automatic re-indexing

### Evaluation Tests (`pnpm run verify:eval`)

Performance and quality metrics:

- Search precision/recall
- Response time benchmarks
- Coverage metrics

## CI/CD Integration

```yaml
# Example GitHub Actions workflow
- name: Run comprehensive verification
  run: pnpm run verify

# Or run categories in parallel
- name: Unit & Dart tests
  run: |
    pnpm run verify:unit &
    pnpm run verify:dart &
    wait

- name: Integration tests
  run: pnpm run verify:integration
```

## Test Output

### Success

```
============================================================
📋 Test Summary
============================================================
✓ PASS unit            (45.23s)
✓ PASS dart            (21.45s)
✓ PASS integration     (12.34s)
✓ PASS tools           (8.56s)
✓ PASS watch           (15.67s)
✓ PASS eval            (5.12s)
============================================================
Total: 6 passed, 0 failed
Duration: 108.37s
============================================================
```

### Failure

```
============================================================
📋 Test Summary
============================================================
✓ PASS unit            (45.23s)
✗ FAIL dart            (5.12s)
  Error: Dart tests failed
  Details: Test timeout in idle TTL behavior
============================================================
Total: 1 passed, 1 failed
Duration: 50.35s
============================================================
```

## Troubleshooting

### Tests timeout

- Increase timeout in script (default: 120s for unit, 60s for others)
- Check for hanging processes: `ps aux | grep kiri`

### Port already in use (tools tests)

- Kill process on port 9999: `lsof -ti:9999 | xargs kill -9`
- Change port in script if needed

### Database lock errors

- Ensure single-fork execution in vitest config
- Clean up stale lock files: `rm -f var/*.lock`

### Watch mode not detecting changes

- Verify git is properly configured in test repo
- Check daemon logs for file watch errors
- Ensure sufficient wait time for re-indexing (current: 10s)

## Development

### Adding New Test Categories

1. Create test function:

```typescript
async function runMyTests(options: VerificationOptions): Promise<TestResult> {
  // Implementation
}
```

2. Add to main():

```typescript
if (options.category === "all" || options.category === "my-category") {
  results.push(await runMyTests(options));
}
```

3. Add npm script in package.json:

```json
"verify:my-category": "tsx scripts/test/verify-all.ts --category my-category"
```

### Modifying Test Fixtures

Sample repository location: `tests/fixtures/sample-repo`

Add more test files to improve MCP tools coverage.

## Performance Notes

- **Unit tests**: ~45s (with coverage)
- **Dart tests**: ~21s (isolated execution)
- **Integration tests**: ~12s
- **Tools tests**: ~8s (includes server startup)
- **Watch tests**: ~15s (includes daemon startup + wait)
- **Eval tests**: ~5s

**Total (all categories)**: ~2 minutes

## License

MIT
