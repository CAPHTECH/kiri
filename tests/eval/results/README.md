# KIRI Evaluation Results History

## Overview

This directory contains historical benchmark results for tracking KIRI search accuracy improvements over time.

**Metrics Tracked:**

- **P@10**: Precision at K=10 (target: ≥0.70)
- **TFFU**: Time To First Useful result in milliseconds (target: ≤1000ms)
- **Metadata Pass Rate**: Percentage of `requiresMetadata` queries whose `why` tags include `metadata:filter` or `boost:metadata` (target: 100%)
- **Inbound Link Pass Rate**: Percentage of `requiresInboundLinks` queries whose `why` tags include `boost:links` (target: 100%)
- **Docs Plain Δ**: Difference between `docs` と `docs-plain` カテゴリの P@10 / Metadata Pass / Inbound Pass（front matter 依存度を把握）

**Related:**

- [Golden Set Documentation](../goldens/README.md)
- [Baseline Metrics](../goldens/baseline.json)

---

## How to Record Results

### 1. Run Benchmark

```bash
# Run the golden set evaluation
pnpm run eval:golden

# Optionally specify output directory
pnpm run eval:golden --out var/eval/2025-11-11-feature-x

# Compare docs vs docs-plain only
pnpm run eval:golden --categories docs,docs-plain --out var/eval/docs-compare
```

### 2. Review Generated Output

The benchmark script generates two files in the output directory (default: `var/eval/`):

- `latest.json`: Detailed per-query results
- `latest.md`: Summary table (copy-paste ready)

When front matter 比較を行う場合は `var/eval/docs-compare/` を出力先に指定し、`docs` / `docs-plain` 両カテゴリの差分（`Category Δ Metrics` セクション）をこのディレクトリから参照できるようにする。

### 3. Create Result Entry

Copy the generated Markdown summary to a new file in this directory:

```bash
# Copy generated summary
cp var/eval/latest.md tests/eval/results/2025-11-11-baseline.md

# Or manually create with date-based naming
# Format: YYYY-MM-DD-{description}.md
```

### 4. Update Summary Table

Add a new row to the "Results Summary" table below with:

- Date
- Version (from package.json)
- Git SHA (short form)
- Dataset version (from queries.yaml)
- P@10 (overall)
- Avg TFFU
- Metadata / inbound pass rates (note if <100%)
- Notes (brief description of changes)

---

## Results Summary

| Date       | Version | Git SHA | Dataset             | P@10  | Avg TFFU | Notes                                                                                      |
| ---------- | ------- | ------- | ------------------- | ----- | -------- | ------------------------------------------------------------------------------------------ |
| 2025-12-30 | 0.25.8  | ef2fc09 | v2025-11-docs-plain | 0.243 | 7ms      | Issue #186 baseline measurement; R@5=0.597, TokenSavings=96.7%, Metadata/Inbound Pass=100% |
| 2025-11-17 | 0.10.0  | 9e59843 | v2025-11-docs-plain | 0.286 | 1ms      | Baseline after metadata hint/docmeta split; docs pass=100%, docs-plain intentionally fails |

**Legend:**

- ✅ Passed threshold (P@10 ≥ 0.70, TFFU ≤ 1000ms)
- ⚠️ Marginal (within 10% of threshold)
- ❌ Below threshold (regression)

---

## Detailed Results

Individual result files are stored in this directory with the format:

```
YYYY-MM-DD-{description}.md
```

**Examples:**

- `2025-11-11-baseline.md`: Initial baseline measurement
- `2025-11-15-phrase-aware.md`: After implementing phrase-aware tokenization
- `2025-12-01-semantic-rerank.md`: With semantic reranking enabled

---

## Interpreting Results

### P@10 (Precision at K=10)

**Definition:** Fraction of relevant results in top 10
**Calculation:** (# relevant in top 10) / 10

**Interpretation:**

- **≥0.80**: Excellent - Most queries return highly relevant results
- **0.70-0.79**: Good - Meets target, minor improvements possible
- **0.60-0.69**: Fair - Below target, investigate low-performing categories
- **<0.60**: Poor - Significant accuracy issues

**Common Causes of Low P@10:**

- Incorrect `expected.paths` in queries.yaml
- Missing or misconfigured `boost_profile`
- Overly broad/ambiguous queries
- Scoring weights need tuning

### TFFU (Time To First Useful)

**Definition:** Time in milliseconds until first relevant result appears
**Calculation:** Average timestamp of first relevant result across queries

**Interpretation:**

- **≤500ms**: Excellent - Very responsive
- **500-1000ms**: Good - Meets target
- **1000-2000ms**: Fair - Approaching threshold
- **>2000ms**: Poor - Performance optimization needed

**Common Causes of High TFFU:**

- **Metadata Pass Rate:** Fraction of `requiresMetadata: true` queries that surfaced `metadata:filter` or `boost:metadata` why tags. <100% implies front matter / YAML ingestion regression.
- **Inbound Link Pass Rate:** Fraction of `requiresInboundLinks: true` queries that surfaced `boost:links` why tags. <100% implies `markdown_link` ingestion/boost regression.

Troubleshooting checklist:

- Run `duckdb var/index.duckdb "SELECT count(*) FROM document_metadata_kv"` to verify metadata tables.
- Ensure docs contain valid YAML front matter (look for "Failed to parse Markdown front matter" warnings).
- Check for "Markdown link table not found" warnings; regenerate index if necessary.

- Cold start overhead (insufficient warmup)
- Complex queries with many keywords
- FTS extension not available (falling back to ILIKE)
- Database not indexed properly

### By-Category Breakdown

Review category-specific metrics to identify weaknesses:

```markdown
## By Category

| Category | P@10 | Avg TFFU | Count | Status |
| -------- | ---- | -------- | ----- | ------ |
| bugfix   | 0.85 | 650ms    | 5     | ✅     |
| feature  | 0.70 | 820ms    | 5     | ✅     |
| refactor | 0.55 | 950ms    | 5     | ❌     |
| infra    | 0.75 | 720ms    | 5     | ✅     |
| docs     | 0.80 | 880ms    | 5     | ✅     |
```

**Action Items:**

- ❌ refactor: P@10 below threshold → Review query design or expected paths
- ⚠️ docs: TFFU approaching limit → Consider boost_profile optimization

---

## Regression Detection

### Automatic Detection

The benchmark script compares results against `baseline.json`:

```bash
# Output includes regression warnings
🎯 KIRI Golden Set Benchmark Results
=====================================
Overall: P@10 = 0.68 ❌ (target: ≥0.70)
         TFFU = 1050ms ⚠️ (target: ≤1000ms)

⚠️ REGRESSIONS DETECTED:
  - P@10 decreased by 5.7% (0.72 → 0.68)
  - TFFU increased by 15% (910ms → 1050ms)
```

### Manual Verification

Compare sequential result files to track trends:

```bash
# View difference between two runs
diff tests/eval/results/2025-11-11-baseline.md \
     tests/eval/results/2025-11-15-phrase-aware.md
```

### Threshold Updates

If baseline metrics consistently exceed targets, update thresholds in `baseline.json`:

```json
{
  "thresholds": {
    "minP10": 0.75, // Raised from 0.70
    "maxTTFU": 800 // Lowered from 1000
  }
}
```

**When to Update:**

- After major accuracy improvements
- 3+ consecutive runs exceeding current thresholds
- New dataset version with different complexity

---

## Troubleshooting

### Results File Not Generated

**Symptoms:** `var/eval/latest.md` doesn't exist after running benchmark

**Causes:**

- Benchmark script failed (check stderr)
- Output directory not created
- Permission issues

**Solution:**

```bash
# Create output directory
mkdir -p var/eval

# Run with verbose logging
pnpm run eval:golden --verbose
```

### Inconsistent Results Between Runs

**Symptoms:** P@10/TFFU vary significantly (>10%) across identical runs

**Causes:**

- Insufficient warmup
- Background processes affecting timing
- Database cache not cleared between runs

**Solution:**

```bash
# Ensure stable measurement environment
# 1. Close other applications
# 2. Run benchmark multiple times and average
pnpm run eval:golden
pnpm run eval:golden
pnpm run eval:golden

# 3. Review warmup configuration in run-golden.ts
```

### Dataset Version Mismatch

**Symptoms:** "Dataset version mismatch" warning in output

**Causes:**

- `queries.yaml` updated but baseline.json not updated
- Comparing results across different query sets

**Solution:**

```bash
# Update baseline after dataset changes
pnpm run eval:golden
# Review output, then update baseline.json manually
# Or re-run with --update-baseline flag (if implemented)
```

---

## Best Practices

### 1. Baseline Before Changes

Always run benchmark before making scoring/ranking changes:

```bash
# Before implementing feature
git checkout -b feature/semantic-rerank
pnpm run eval:golden --out var/eval/before-semantic

# After implementation
pnpm run build
pnpm run eval:golden --out var/eval/after-semantic

# Compare
diff var/eval/before-semantic/latest.json var/eval/after-semantic/latest.json
```

### 2. Document Context

Include detailed notes in result entries:

```markdown
## Notes

- Implemented phrase-aware tokenization (Issue #63)
- Changed scoring profile weights (PR #71)
- FTS extension enabled for this run
- Dataset version unchanged from v2025-11-11
```

### 3. Track Experiments

Use descriptive filenames for experimental runs:

```
2025-11-20-experiment-boost-1.5x.md
2025-11-20-experiment-boost-2.0x.md
2025-11-20-final-boost-1.5x.md
```

### 4. Archive Old Results

After 10+ result files, consider archiving:

```bash
mkdir -p tests/eval/results/archive/2025-Q4
mv tests/eval/results/2025-11-*.md tests/eval/results/archive/2025-Q4/
```

---

## References

- [Issue #65](https://github.com/CAPHTECH/kiri/issues/65): Golden set introduction
- [docs/overview.md](../../../docs/overview.md): P@10/TFFU target definitions
- [docs/search-ranking.md](../../../docs/search-ranking.md): Scoring algorithm details
- [src/eval/metrics.ts](../../../src/eval/metrics.ts): Metrics implementation
