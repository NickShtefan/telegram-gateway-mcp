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
