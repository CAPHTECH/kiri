---
doc_id: "GUIDE-001"
title: "Authoring Docs for KIRI Search"
category: "docs"
tags:
  - docs
  - metadata
  - best-practices
  - plain-corpus
service: "kiri"
---

# Authoring Docs for KIRI Search

> Related: [Testing & Evaluation](./testing.md) / [Search & Ranking](./search-ranking.md)

KIRI’s document search relies on structured metadata and Markdown signals. This guide captures the practices that keep docs discoverable and prevent regressions such as those highlighted in assay-kit benchmarks (see `var/assay/` reports).

## 1. Use Complete Front Matter

- **Always include** `title`, `category`, `tags`, and `service`.
- Treat `tags` as the canonical list of keywords. Anything you expect in `tag:<keyword>` queries must live here.
- Keep tags lowercase and singular (`observability`, `runbook`, `security`, …) to maximize matching.
- Explain deprecated or renamed features by adding both old and new tags while the transition is in flight.
- Custom keys are supported as well. Use the `meta.<key>:<value>` or `frontmatter.<key>:<value>` syntax when filtering from MCP tools. Example: `meta.id:runbook-001` will match a doc with `id: runbook-001` in its front matter even though `id` is not part of the built-in alias list (`tag/category/title/service`).

Front matter drives:

| Signal        | Why tag                             | Purpose                   |
| ------------- | ----------------------------------- | ------------------------- |
| Tags/Category | `metadata:filter`, `boost:metadata` | Structured filter/ranking |
| Title         | `text:` + `phrase:` matches         | Precise phrase hits       |

If front matter is omitted, P@10 and metadata pass rate collapse to zero (see docs-plain benchmark).

## Metadata aliases & filters

| Shortcut                    | Equivalent key                            | Typical usage                                                 |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `tag:<value>`               | `meta.tags:<value>`                       | Canonical keywords such as `tag:degrade`, `tag:observability` |
| `category:<value>`          | `meta.category:<value>`                   | High-level doc grouping (e.g., `category:operations`)         |
| `title:"..."`               | `meta.title:"..."`                        | Exact title phrase matches                                    |
| `service:<value>`           | `meta.service:<value>`                    | Service-scoped runbooks (`service:kiri`)                      |
| `meta.<key>:<value>`        | `document_metadata_kv.key=<key>`          | Arbitrary keys like `meta.id:runbook-001`, `meta.owner:sre`   |
| `docmeta.<key>:<value>`     | `document_metadata_kv.key=<key>` (strict) | Force doc-only filtering (e.g., `docmeta.id:runbook-001`)     |
| `frontmatter.<key>:<value>` | Same as `meta.<key>`                      | Alternative prefix when emphasizing front matter origin       |

Notes:

- `metadata.<key>:<value>` is also accepted and behaves like `meta.<key>`.
- `meta.*` / `tag:` / `category:` act as **hints**: docs get top billing but related code remains eligible. Use `docmeta.*` or `metadata.*` when you truly want docs-only filtering (e.g., compliance exports).
- Non-string values are coerced to strings before comparison; keep IDs lowercase to avoid case mismatches.
- Full alias list lives in `src/server/handlers.ts` (`METADATA_ALIAS_MAP`). Update this section whenever aliases change.

## 2. Link Related Content

- Cross-link runbooks, designs, and READMEs. Incoming links are converted into `markdown_link` entries and surfaced as `boost:links`.
- Prefer relative paths (`[Runbook](./runbook.md#incident-response)`) so links survive repo moves.
- Add “Related” sections at the top of each doc for quick traversal.

## 3. Reinforce Keywords in the Body

- Mirror front matter tags in headings and paragraphs; simple `text:` matches act as the fallback when metadata is missing.
- Use descriptive H2/H3 headings (`## Observability SLO Workflow`) instead of stylistic phrases.
- Include code or config snippets when they contain canonical names (e.g., environment variables) so fallback string search can still succeed.

## 4. Choose Stable Paths

- Place docs under `docs/<domain>/<topic>.md` or similar predictable layouts.
- Avoid generic file names (`guide.md`, `notes.md`); file paths appear in `path-keyword:` reasons and help ranking.
- For multi-language docs, keep the English canonical path and store translations beside it (`runbook.ja.md`) so links stay stable.

## 5. Validate with Benchmarks

1. Ensure your dataset includes docs-focused queries (update or add a dataset YAML such as `datasets/kiri-ab.yaml`).
2. Run assay evaluation:

   ```bash
   pnpm run assay:evaluate -- --dataset datasets/kiri-ab.yaml
   ```

3. If you need A/B comparison (e.g., front matter impact), prepare two variants and run:

   ```bash
   pnpm run assay:compare -- --dataset datasets/kiri-ab.yaml --variant-a default --variant-b balanced
   ```

4. Inspect `var/assay/eval-*.md` or comparison reports and confirm docs category metrics.

## 6. When Adding New Docs

1. Copy an existing doc as a template to keep the front matter format.
2. Fill out the fields before writing content.
3. Run the docs-only benchmark to ensure your doc is discoverable.
4. Update the assay dataset YAML (e.g., `datasets/kiri-ab.yaml`) if the doc represents a new canonical runbook or workflow.

## 7. Troubleshooting Checklist

- **Metadata pass failure**: check for malformed YAML (e.g., tabs, missing delimiters).
- **Inbound pass failure**: ensure other docs actually link to yours; one-way links do not generate inbound counts.
- **`pnpm run assay:evaluate` fails on plain corpus**: regenerate `tmp/docs-plain` and rerun the security lock command.
- **Dictionary hints look stale**: enable logging with `KIRI_HINT_LOG=1`, run a few golden queries, then rebuild the dictionary:
  ```bash
  pnpm exec tsx scripts/diag/dump-hints.ts --db var/index.duckdb --repo .
  pnpm exec tsx scripts/diag/build-hint-dictionary.ts --db var/index.duckdb --repo .
  pnpm exec tsx scripts/diag/cleanup-hints.ts --db var/index.duckdb --days 14
  ```
  This keeps `hint_dictionary` synchronized with the latest artifact hints when metadata alone is too abstract.

Following these practices keeps KIRI’s context tools reliable and makes regressions easy to detect. Remember: every doc without front matter reduces overall P@10, so treat metadata as part of the contract, not an optional header.
