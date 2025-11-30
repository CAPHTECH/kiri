---
doc_id: "GUIDE-002"
title: "Path Penalties User Guide"
category: "configuration"
tags:
  - path-penalty
  - boosting
  - config
service: "kiri"
---

# Path Penalties User Guide

## Goal

Tune ranking for repository-specific directories by applying multiplicative path multipliers.

## Recommended Setup (YAML)

Create `.kiri/config.yaml` at the repo root:

```yaml
path_penalties:
  - prefix: src/
    multiplier: 1.4 # boost src
  - prefix: external/
    multiplier: 0.3 # down-weight external
```

## Environment Variable Override

- Format: `KIRI_PATH_PENALTY_<PREFIX_ENCODING>=<multiplier>`
- Encode `/` as `__`. Example: `KIRI_PATH_PENALTY_src__api__=0.8`

## Precedence (last wins)

`boost_profile` defaults < Environment variables < `.kiri/config.yaml`

## Normalization Rules

- Convert `\` to `/` (POSIX style).
- Strip drive letters and reject paths containing `..` (repo-relative only).
- Preserve trailing `/` only if provided.

## Application & Refresh

- Loaded at server/daemon start.
- After editing `.kiri/config.yaml` or env vars, **restart the server/daemon** to refresh (values are cached in-process).

## Quick Verification

1. Add `.kiri/config.yaml`
2. Restart server/daemon (`kiri --repo . --db .kiri/index.duckdb --watch`, etc.)
3. Run `context_bundle` or `files_search` and confirm ranking shifts for the targeted paths.

## Troubleshooting

- Error: `Path penalty prefix "..." must not contain ".."` → remove `..`; only repo-relative paths are allowed.
- Not applied: restart the process to drop caches after config changes.
