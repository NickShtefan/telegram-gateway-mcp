# Cleanup progress

Authorized scope: stages 1-5 of the cleanup plan in `repository-audit.md`. Stage 6 (snapshot audit, transfer and publication) and optional worktree archiving are outside this run.

Baseline: `5c203d9ec0c0e511c0e797a288ee842f267823d8`, clean main checkout. The existing detached worktree is retained. No gateway state, credentials, lab deployment or Telegram data is modified.

## Change journal

| Stage | Files or symbols | Reason and change | Validation | Commit |
| --- | --- | --- | --- | --- |
| 1 | package.json, scripts/clean-build.mjs, .gitignore | C1/C4/C8: clean dist on every build and before packing; allow only JavaScript, declarations, README and future license notices. Source maps remain local build outputs. Ignore local keys, logs, backups and worktrees. | Build, typecheck and 694 tests pass. Rebuild removes a synthetic stale artifact; 192 outputs, 130 allowed package files. npm uses an isolated writable cache. | 9f3a741 |

## Remaining release gates

This cleanup does not select the first public version or installation/isolation model. MIT holder/provenance/notices, full snapshot secrets/PII audit, target-platform verification, CI, release approval and new repository transfer remain separate preparation work.

Stage 2.1 (F1): removed the unsafe hang exception from media and limiter options. Deadlines shut down every lane before requesting supervisor restart. Regression coverage exercises MediaService, TgGateway, limiter and the runtime watchdog with a synthetic session and fake exit.

Stage 2.1 validation: build, typecheck, 694 tests passed; commit `9f2fe5a`. Stage 2.2 (F2): filter short terms in SQLite before counts and pagination, using JavaScript Unicode case folding. MCP regression covers alternating and sparse matches, all pages and long-only queries.

Stage 2.2 validation: build, typecheck, 696 tests passed. Stage 2.3 (F3): enforce actual full-buffer and cache-file sizes, including photos and missing document metadata. Tests cover exact boundary, oversized files, cache and uncapped previews. This does not cap memory during download.

Stage 2.3 validation: build, typecheck, 699 tests passed. Stage 2.4 (F5): validate calendar components before date parsing; reject normalized impossible dates while preserving leap days, relative periods, Unix seconds and timezone conversion.

Stage 2.4 validation: build, typecheck, 714 tests passed. Stage 2.5 (F4): reject inherited log-level keys; tests verify fallback filtering and every supported level.

Stage 2.5 validation: build, typecheck, 725 tests passed. Stage 2.6 (F6): display explicit timestamp zero independently of an absent boundary.

Stage 2.6 validation: build, typecheck, 726 tests passed. Stage 2 is complete.

Stage 3: removed both write-only DeadlineError fields and 26 module-local value exports (implementations retained). Build/typecheck check for external consumers. Corrected M1-M8 comments and three SQLite job headings. AuditRepo.recent, EntitiesRepo.put, all modules, Unicode fixtures and eight published migrations remain.

Stage 3 validation: build/typecheck, 726 tests, bash syntax and ShellCheck pass; commit `f23b12f`.

Stage 4: prepared an explicit source-to-destination manifest. Generalized README, architecture, tool contracts, connections, risks and synthetic scenarios; prepared portable public AGENTS.md separately so current private operating rules remain intact. Test identities/handles are synthetic (user_a/user_b, fixture_channel/fixture_market); permissions and session state are untouched. Private plan/decisions/questions/research/evidence, Russian audit, laboratory instructions and installer remain excluded. Package metadata stays private; public version, installation, license and release preparation are explicit pending gates.

## Stage 5 verification (October 7, 2026)

Verified source revision: `7a7600c32e29f8858107afbb4f59e454a2ffcc7c`. Environment: macOS arm64, Node 24.10.0, npm 11.6.1.

| Check | Result |
| --- | --- |
| Build, typecheck, tests | Pass; 21 files, 726 tests (baseline 694) |
| Output hygiene | 192 outputs for 64 current modules; 42 obsolete outputs removed; rebuild drops synthetic stale output |
| Installer syntax and ShellCheck | Pass; installer not executed |
| Documentation links, public selection, English/U+2014 checks | Pass; Russian owner audit is private and excluded |
| Migrations | Byte-identical to baseline; eight published migrations retained |
| Source transfer selection | 103 explicit source/destination files; 13 tracked preparation/operations files excluded |
| Real npm archive | 130 allowed files, 141922 bytes; no stale modules, maps, tests, worktrees, private documents or runtime state |
| Archive SHA-256 | `49e5d7f3f0f62ff49deeb4973b1f8d756b298360abdf4de870449d21bc0d6083` |
| Clean archive installation | Pass, isolated temporary directory/cache, production dependencies only, install scripts disabled |
| Installed CLI and modules | help/version pass; all 64 module paths verified (63 imports plus CLI entry point); no vitest/TypeScript installed |
| Installed MCP over HTTP and stdio | Pass; 13 core/index tools, four search pages, IDs 40,38,36,34,32,30,28,26,24,22 exactly once; INVALID_ARGUMENT for impossible date; zero date displayed |
| claude -p 2.1.219 | Attempted; expired OAuth login returns 401 before scenario execution; compatibility remains open |
| codex exec 0.141.0 | Attempted; normal CLI startup permitted after sandbox escalation. Service rejects default gpt-5.4 and user-configured gpt-6.1-sol for the signed-in ChatGPT account; scenario remains open |
| opencode run | Not installed in the checked local CLI locations; scenario remains open |

The same English regression prompt is saved in `scenarios.md`. SDK transport proof is separate from model-client scenario proof. Stage 5 is complete for local code/package checks, but the three-client compatibility gate is not closed. Owner action is needed for working client/provider access; no credentials were displayed or copied, and no user client configuration was changed.

The archive contains the current private metadata, not a selected public version. LICENSE/notices are still release gates. No new repository, public snapshot, publication, release, deployment or live Telegram operation was performed. Old worktree, primary node_modules and runtime state remain.

## Commits

```text
7a7600c docs: prepare public files and synthetic examples
f23b12f refactor: narrow exports and correct internal comments
72eac32 fix(args): include zero date boundaries in headers
0d87d38 fix(log): reject inherited log level keys
53aa446 fix(args): reject impossible calendar dates
6dde678 fix(media): enforce full-file limits on actual bytes
8782654 fix(index): filter short terms before pagination
9f2fe5a fix(media): stop all queues after a hung download
9f3a741 build: clean outputs and restrict package contents
```

Revert an implementation step with a new revert commit if needed; preserve private history. Final reporting changes only the private audit/plan/progress documents, so the verified public source/package payload remains unchanged.
