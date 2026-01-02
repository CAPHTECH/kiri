---
doc_id: "RUN-210"
title: "Issue 210 – Uncertainty Register"
category: "runbook"
tags:
  - issue-210
  - uncertainty
service: "kiri"
---

# Issue 210 – Uncertainty Register (2026-01-02)

## Decision (1-3 lines)

- **Decision**: Ship issue #210 (symbol-first snippets_get + range metadata) via PR #213 without regressing daemon/watch flows or compact-mode defaults.
- **Deadline**: 2026-01-03 (before weekend freeze).
- **Stakes**: Blocking CI prevents token-usage optimizations from landing; daemon regressions would strand MCP server operators.
- **Constraints**: Keep scope within server runtime + config assets; no breaking API surface or new config files in this patch.

## Register (max 10 to start)

|   ID | Category       | Uncertainty (question)                                                                                   | Current hypothesis                                                                                                      | Impact (1-5) | Evidence (1-5) | Urgency (1-5) | Effort (1-5) | Priority | Next observation                                                             |
| ---: | -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -----------: | -------------: | ------------: | -----------: | -------: | ---------------------------------------------------------------------------- |
| U-01 | Build/runtime  | Will daemon/watch tests keep failing because dist bundles miss `config/security.yml`?                    | Runtime currently resolves `dist/config/security.yml`; CI dist lacks copy, so fallback/root detection fix will unblock. |            5 |              2 |             5 |            2 |       50 | Read `src/shared/security/config.ts`, add fallback path, rerun daemon tests. |
| U-02 | Packaging      | Are there other non-TS assets (locks, YAML) that dist/runtime needs but tsconfig skips?                  | Probably only `config/security.yml`; verify other `config/*.yml` references to avoid future ENOENT.                     |            4 |              3 |             3 |            3 |       12 | Grep for `config/` loads, confirm watchers/integration tests cover them.     |
| U-03 | Feature parity | Did issue/210 actually flip `snippets_get` default view to `symbol` after rebasing on compact-mode main? | `resolveDefaultSnippetsView()` returns `symbol`, but need to ensure env var + docs match.                               |            3 |              4 |             3 |            2 |        9 | Inspect handler/tests + docs for default statements.                         |
| U-04 | Documentation  | Do docs/tests teach users about compact default + symbol default interplay?                              | Most doc updates merged, but verify API references mention both defaults.                                               |            2 |              3 |             2 |            3 |        4 | Spot-check `docs/tools-reference.md` + API doc for defaults.                 |

### Top Priorities

- **P1**: U-01 (Priority 50) – fix runtime fallback so CI passes.
- **P2**: U-02 (Priority 12) – ensure no other asset gaps remain.
- **P3**: U-03 (Priority 9) – confirm snippet defaults and note in PR.

## Observation Backlog

### T-01: Patch security config fallback (for U-01)

- **Hypothesis**: Allowing `loadSecurityConfig` to fall back to repository `config/security.yml` when `dist/config/security.yml` is absent will let daemon/watch tests pass without copying assets.
- **Method**: Code inspection + targeted daemon test run.
- **Timebox**: 2h (includes coding + test run).
- **Steps**:
  1. Add helper in `src/shared/security/config.ts` that probes `dist/.../config/security.yml` and then `config/security.yml`.
  2. Update loader/evaluator to use helper; add regression tests covering both paths.
  3. Run `pnpm vitest tests/shared/security` and `pnpm vitest tests/daemon/daemon.watch.spec.ts`.
- **Decision rule**:
  - If tests pass locally, accept change and push.
  - If daemon test still fails with ENOENT, escalate to asset-copy approach.
- **Evidence artifact to collect**: Vitest logs for security + daemon suites.
- **Output**: Patched TypeScript + new tests.
- **Owner**: Codex.
- **Status**: Done (2026-01-02) – fallback implemented + daemon/spec + security suites passing.

### T-02: Audit other config assets (for U-02)

- **Hypothesis**: `security.yml` is the only runtime-critical YAML referenced via relative disk paths.
- **Method**: Repo search + doc review.
- **Timebox**: 30m.
- **Steps**:
  1. `rg -n \"config/.*\\.yml\" src -g\"*.ts\"` to list runtime references.
  2. Verify each reference already works under dist (either uses `resolve()` or bundler).
  3. Document findings alongside PR notes.
- **Decision rule**:
  - If new asset gaps found, add similar fallbacks or copy logic.
  - Otherwise, mark risk as mitigated.
- **Evidence artifact**: Search log & summary note.
- **Output**: Confidence note + optional doc snippet.
- **Owner**: Codex.
- **Status**: Done (2026-01-02) – only `config/security.yml` needed fallback; other loaders already probe multiple paths.

### T-03: Confirm symbol default coverage (for U-03)

- **Hypothesis**: Handler + docs already default to `view=symbol` unless explicit view/range overrides.
- **Method**: Read `src/server/handlers/snippets-get.ts` + tests + docs.
- **Timebox**: 20m.
- **Steps**:
  1. Inspect `resolveDefaultSnippetsView` and call sites.
  2. Review tests ensuring default view is symbol.
  3. Check API docs for mention; update if missing.
- **Decision rule**:
  - If default mismatch found, file follow-up.
  - If consistent, cite evidence in PR summary.
- **Evidence artifact**: Code references + doc diff if needed.
- **Output**: Verified statement in PR description.
- **Owner**: Codex.
- **Status**: Done (2026-01-02) – handler/test/doc review confirms default `view` is `symbol` absent explicit overrides.
