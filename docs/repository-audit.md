# tg-mcp repository inventory and cleanup review

Prepared October 7, 2026, for the owner to select cleanup scope before the open-source transfer.

The current source tree is compact and connected: all 64 production TypeScript modules belong to the CLI dependency graph, including one type-only storage contract. The clearest cleanup candidates are local build leftovers and an older nested Git worktree. The current npm packing rules also admit that worktree and the obsolete build outputs. Documentation needs a public/private split and general installation examples; deleting working source modules is not supported by this inventory.

## Inspection baseline

- Source commit: `66fb7e18ae64161322b0c0e4360dfec03a9d3ae3`, current private `main`.
- The main checkout and the nested worktree were clean at inspection. The main checkout had 110 tracked files. Counts below describe that source commit and exclude this new report and its status entry.
- Environment: macOS, Darwin 25.6.0, arm64; Node 24.10.0; npm 11.6.1.
- Scope: every tracked file, source import/export relationships, tests, configuration, documentation, local directory metadata, and a dry-run npm file list. Nested-worktree contents and installed dependency internals were inventoried by metadata, not reviewed as current project code.
- No files were removed, no production code or configuration was changed, and no lab deployment, Telegram login/write, migration or publication was performed. Build verification refreshed existing generated outputs without removing old ones.

This is a structural inventory and cleanup review. Filename exclusions and lock-file license labels do not constitute a complete secret, provenance or third-party license audit. Existing live Telegram evidence remains in [plan.md](plan.md); this review does not add live or cross-platform proof.

## Directory map

```text
tg-mcp/
  .git/                         private history and worktree metadata
  .claude/worktrees/            one registered older checkout, not tracked by main
  dist/                         current generated outputs plus old leftovers
  node_modules/                 installed development/runtime dependencies
  docs/                         13 current documents
  scripts/lab-install.sh        private macOS installer
  src/
    cli/                        commands and daemon startup
    core/                       Telegram/session/runtime infrastructure
    mcp/tools/                  five toolsets and shared definitions
    policy/                     identities, scopes, audit, untrusted text
    services/                   Telegram reads, writes, exports, index and jobs
    storage/                    contracts, SQLite and migrations
    transport/                  HTTP server and stdio proxy
    writegate/                  prepared actions and confirmation
    __tests__/helpers/          shared test doubles and test runtime
    runtime.ts                  process-level composition
  package.json                  package and CLI metadata
  package-lock.json             reproducible dependency graph
  tsconfig*.json                TypeScript checks/build
  vitest.config.ts              test configuration
  README.md, AGENTS.md,
  CLAUDE.md, .gitignore          overview, agent rules and exclusions
```

The tests are adjacent to each layer under its `__tests__/` directory. There is no tracked `.github/`, root `reference/`, current `src/automation/`, coverage directory or runtime-data directory in this checkout.

| Area | Files in Git | Regular files on disk | Apparent file size | Role |
|---|---:|---:|---:|---|
| Root files | 9 | 9 | 94.1 KiB | Metadata, lock file, compiler/test settings and agent instructions |
| src/ | 87 | 87 | 750.8 KiB | 64 production modules, 21 test files, 2 helpers |
| docs/ | 13 | 13 | 151.8 KiB | Architecture, owner decisions, operations, scenarios and release preparation |
| scripts/ | 1 | 1 | 15.4 KiB | Existing private macOS installer |
| dist/ | 0 | 234 | 1.22 MiB | Generated JavaScript, declarations and source maps |
| node_modules/ | 0 | 4,879 | 80.31 MiB | Installed dependencies; also 9 symlinks |
| .claude/ | 0 | 5,273 | 82.75 MiB | Older registered checkout and its own dependencies; also 9 symlinks |
| .git/ | Git metadata | 343 | 2.90 MiB | Private history, refs and registered-worktree metadata |

Sizes sum regular-file lengths without following symlinks; they are not allocated disk-block measurements. The 110 tracked files total 1,036,458 bytes and 22,328 physical lines, including JSON, comments and blank lines. Production TypeScript has 11,410 lines; tests and helpers have 6,079.

## Current source structure

The executable entry point is [src/cli/index.ts](../src/cli/index.ts). It redirects logging to stderr before dynamically importing `main`, sets a restrictive umask and dispatches the CLI. `serve` composes the runtime and services, registers the toolsets and starts HTTP. `stdio` forwards requests to that daemon and opens no Telegram session.

The Telegram path is MCP tool, account/scope policy, service, `TgGateway`, account limiter and client pool. Writes additionally pass through the prepared-action store and `tg_confirm`. `jobs.ts` runs exports/indexing started by tool calls; it is not an agent scheduler. Core and service modules have no direct imports from MCP or transport.

| Source area | Production files | Test files | Production lines | Test lines | Responsibility |
|---|---:|---:|---:|---:|---|
| src/cli/ | 7 | 1 | 924 | 302 | Commands, login, administration and daemon startup |
| src/core/ | 15 | 6 | 2,017 | 1,046 | Sessions, configuration, limiter, errors, lock and safe files |
| src/mcp/ | 11 | 3 | 2,298 | 1,378 | Tool contracts, registry and response formatting |
| src/policy/ | 4 | 2 | 329 | 217 | Users/accounts, scopes, audit and untrusted text |
| src/services/ | 18 | 5 | 3,891 | 1,552 | Gateway capabilities and tool-started jobs |
| src/storage/ | 3 | 1 | 1,081 | 269 | Contracts, SQLite implementation and schema migration |
| src/transport/ | 2 | 1 | 335 | 251 | HTTP and stdio |
| src/writegate/ | 3 | 2 | 445 | 846 | Preview, consent workflow and execution journal |
| src/runtime.ts | 1 | 0 | 90 | 0 | Shared dependency composition |
| Shared test helpers | 0 | 0 | 0 | 218 | Two helper files, counted separately from test files |

The largest production files are `mcp/tools/core.ts` (805 lines), `storage/sqlite.ts` (558), `services/write.ts` (427), `core/limiter.ts` (404) and `services/messages.ts` (376). These sizes correspond to multiple existing operations, not evidence of unused code.

### Reachability and duplicates

TypeScript syntax and symbol analysis covered static imports, relative re-exports, literal dynamic imports, production use and test use. All relative imports resolve. All 64 production modules are reachable from the executable entry point when type dependencies are included; 63 have value-import paths. `storage/port.ts` is the required type-only contract.

No byte-identical duplicate tracked files were found. No unreferenced standalone exported function or constant was confirmed: the apparent `main` exception is the dynamically loaded CLI entry point. Some functions/constants are exported but only used inside their own module, such as `scopeTarget`, `loadEnvFile` and formatter helpers. Removing their export modifier would be an optional encapsulation change, not deleting unused behavior. Helpers directly imported by tests must remain available to those tests.

File reachability does not prove that every branch or public class method is necessary. This review therefore supplies no justified list of whole source modules to delete. The strict compiler also checks unused locals and parameters; green checks alone do not justify deleting exported contracts or behavior.

## Complete tracked file inventory

Each source and test path below belongs to the inspected 110-file snapshot. Production modules and tests are preservation candidates unless a later, specific analysis establishes an obsolete behavior. Documentation disposition is considered separately in the cleanup options.

### Root configuration and instructions

| File | Lines | Contents |
|---|---:|---|
| [.gitignore](../.gitignore) | 21 | Excludes installed dependencies, builds, common secrets, state and local client settings. |
| [AGENTS.md](../AGENTS.md) | 64 | Agent constraints, architecture rules, language and private/public Git workflows. |
| [CLAUDE.md](../CLAUDE.md) | 1 | Loads AGENTS.md for Claude Code; its single line is intentional. |
| [README.md](../README.md) | 73 | Gateway overview, 23 tools, current verification status and directory map. |
| [package-lock.json](../package-lock.json) | 2,438 | Resolved dependency graph and reproducible installation, lock format 3. |
| [package.json](../package.json) | 30 | Private package metadata, CLI bin, dependency declarations and development commands. |
| [tsconfig.build.json](../tsconfig.build.json) | 4 | Production emit settings; excludes tests and helpers. |
| [tsconfig.json](../tsconfig.json) | 24 | Strict TypeScript settings including unused local/parameter checks; includes tests. |
| [vitest.config.ts](../vitest.config.ts) | 9 | Test discovery, environment and timeout settings. |

### Installation script

| File | Lines | Contents |
|---|---:|---|
| [scripts/lab-install.sh](../scripts/lab-install.sh) | 369 | Private macOS installation from a full SHA with a service user, protected Node/code, shared files and launchd. |

### Documentation

| File | Lines | Contents |
|---|---:|---|
| [docs/architecture.md](../docs/architecture.md) | 124 | Layers, request flow, storage, session ownership, writes and deployment. |
| [docs/connect.md](../docs/connect.md) | 207 | Claude Code, Codex, OpenCode, Hermes and generic stdio configurations; includes lab-specific examples. |
| [docs/decisions.md](../docs/decisions.md) | 489 | Stable numbered decisions 1 through 50 and their accepted/proposed status. |
| [docs/deploy.md](../docs/deploy.md) | 173 | Existing private macOS deployment, owner administration, updates and diagnosis. |
| [docs/findings.md](../docs/findings.md) | 52 | Historical Telegram, teleproto, Node and client findings, including lab observations. |
| [docs/naming-research.md](../docs/naming-research.md) | 79 | Research supporting the selected public name and listing metadata. |
| [docs/open-questions.md](../docs/open-questions.md) | 26 | Deferred preparation choices and other owner questions; initial review is closed. |
| [docs/open-source-plan.md](../docs/open-source-plan.md) | 217 | Preparation stages, transfer order, responsibilities and publication gates. |
| [docs/plan.md](../docs/plan.md) | 112 | Implementation and live verification evidence, preparation status and future ideas. |
| [docs/risks.md](../docs/risks.md) | 63 | Account, security, operational and Telegram policy risks. |
| [docs/scenarios.md](../docs/scenarios.md) | 79 | Step-by-step marketplace, summary, agent-owned monitoring/conversation and button scenarios. |
| [docs/tools.md](../docs/tools.md) | 120 | Agent-facing tool contracts, toolsets, scopes and confirmation limits. |
| [docs/use-cases.md](../docs/use-cases.md) | 65 | Owner use cases and their required gateway capabilities. |

### CLI

| File | Lines | Contents |
|---|---:|---|
| [src/cli/admin.ts](../src/cli/admin.ts) | 199 | Storage operations for gateway users, tokens, account grants and scopes. |
| [src/cli/doctor.ts](../src/cli/doctor.ts) | 161 | Installation checks, legacy-configuration warnings and optional account connection. |
| [src/cli/index.ts](../src/cli/index.ts) | 18 | Executable entry point; redirects logs, sets umask and dynamically loads main. |
| [src/cli/io.ts](../src/cli/io.ts) | 43 | Terminal output and interactive input, including hidden password input. |
| [src/cli/login.ts](../src/cli/login.ts) | 66 | Owner login command and encrypted-session persistence. |
| [src/cli/main.ts](../src/cli/main.ts) | 306 | Command parsing, help/version output and routing to daemon/proxy/admin commands. |
| [src/cli/serve.ts](../src/cli/serve.ts) | 131 | Daemon lifecycle, session lock, HTTP server, job resumption and housekeeping. |

### Core

| File | Lines | Contents |
|---|---:|---|
| [src/core/auth.ts](../src/core/auth.ts) | 120 | Fresh Telegram login with phone, code and 2FA; prevents unintended account signup. |
| [src/core/chatId.ts](../src/core/chatId.ts) | 77 | Canonical marked chat IDs and conversions to MTProto peer identity. |
| [src/core/clientPool.ts](../src/core/clientPool.ts) | 223 | One lazy MTProto client per account, connection coalescing, deadlines and shutdown. |
| [src/core/config.ts](../src/core/config.ts) | 162 | Environment/default configuration, credentials, session key and retired-toolset compatibility. |
| [src/core/crypto.ts](../src/core/crypto.ts) | 57 | AES-256-GCM session encryption, random tokens and token hashes. |
| [src/core/entities.ts](../src/core/entities.ts) | 208 | Telegram entity normalization, response harvesting and InputPeer conversion. |
| [src/core/errors.ts](../src/core/errors.ts) | 227 | Gateway error types, Telegram error classification and wait information. |
| [src/core/limiter.ts](../src/core/limiter.ts) | 404 | Per-account queues, pacing, priority, FLOOD_WAIT, slow mode and call deadlines. |
| [src/core/lock.ts](../src/core/lock.ts) | 117 | Unix-socket daemon lock, live-owner detection and stale-socket handling. |
| [src/core/log.ts](../src/core/log.ts) | 94 | Stderr logger, sensitive-field redaction and console redirection. |
| [src/core/reactions.ts](../src/core/reactions.ts) | 48 | Reaction identifiers, normalized counters and totals. |
| [src/core/recovery.ts](../src/core/recovery.ts) | 50 | Fatal recovery after a hung call, queue shutdown and process exit. |
| [src/core/safeFs.ts](../src/core/safeFs.ts) | 106 | Trusted directories and safe shared-file creation without following symlinks. |
| [src/core/tg.ts](../src/core/tg.ts) | 84 | Service Telegram entry point through client pool, limiter and entity cache. |
| [src/core/time.ts](../src/core/time.ts) | 40 | Deadlines and delays for external asynchronous operations. |

### MCP

| File | Lines | Contents |
|---|---:|---|
| [src/mcp/args.ts](../src/mcp/args.ts) | 74 | Date windows, limits and other shared tool argument parsing. |
| [src/mcp/cursor.ts](../src/mcp/cursor.ts) | 34 | Opaque cursor encoding, decoding and tool-kind validation. |
| [src/mcp/format.ts](../src/mcp/format.ts) | 246 | Compact message, counter, date, media, link and button output. |
| [src/mcp/server.ts](../src/mcp/server.ts) | 58 | Toolset registry, instructions and a request-scoped MCP server. |
| [src/mcp/tool.ts](../src/mcp/tool.ts) | 164 | Tool definitions, account/scope context, audit and common error handling. |
| [src/mcp/tools/analytics.ts](../src/mcp/tools/analytics.ts) | 106 | One channel-statistics tool. |
| [src/mcp/tools/core.ts](../src/mcp/tools/core.ts) | 805 | Eleven core reading, search, export and media tools. |
| [src/mcp/tools/discover.ts](../src/mcp/tools/discover.ts) | 140 | Three discovery tools: channel lookup, recommendations and forward sources. |
| [src/mcp/tools/indexTools.ts](../src/mcp/tools/indexTools.ts) | 220 | Two tools for index management and local search. |
| [src/mcp/tools/shared.ts](../src/mcp/tools/shared.ts) | 101 | Shared schemas, chat labels, message lookup and byte formatting. |
| [src/mcp/tools/write.ts](../src/mcp/tools/write.ts) | 350 | Six tools for prepared writes, button presses and confirmation/rejection. |

### Policy

| File | Lines | Contents |
|---|---:|---|
| [src/policy/access.ts](../src/policy/access.ts) | 69 | Bearer-token identity and personal/shared account access. |
| [src/policy/audit.ts](../src/policy/audit.ts) | 63 | Tool-call audit records and pruning. |
| [src/policy/envelope.ts](../src/policy/envelope.ts) | 85 | Untrusted-text markers, sanitization, safe labels and bounded text. |
| [src/policy/scopes.ts](../src/policy/scopes.ts) | 112 | Chat allow/deny rules, private-chat modes and permanently blocked service chats. |

### Services

| File | Lines | Contents |
|---|---:|---|
| [src/services/buttons.ts](../src/services/buttons.ts) | 88 | Inline-button types, positions, labels, URLs and revalidation fingerprints. |
| [src/services/comments.ts](../src/services/comments.ts) | 174 | Linked discussion threads, comment pages, ranking and search. |
| [src/services/dialogs.ts](../src/services/dialogs.ts) | 140 | Account dialog pagination, including archived dialogs. |
| [src/services/discover.ts](../src/services/discover.ts) | 191 | Channel discovery, similar channels and forwarding-source counts. |
| [src/services/export.ts](../src/services/export.ts) | 269 | JSONL/CSV jobs, author hashing, phone masking, media previews and safe output. |
| [src/services/history.ts](../src/services/history.ts) | 164 | History windows, message IDs, surrounding context, forum topics and albums. |
| [src/services/index.ts](../src/services/index.ts) | 89 | Service composition and registration of tool-started export/index jobs. |
| [src/services/jobs.ts](../src/services/jobs.ts) | 166 | Persisted export/index jobs, progress, waiting, restart resumption and shutdown. |
| [src/services/links.ts](../src/services/links.ts) | 321 | Pure parsing and construction of Telegram usernames, IDs, links and invites. |
| [src/services/localIndex.ts](../src/services/localIndex.ts) | 318 | SQLite chat/message indexing and trigram FTS5 search with scopes. |
| [src/services/media.ts](../src/services/media.ts) | 271 | Photo/thumbnail retrieval, DC redirects, cache, size limits and disk quotas. |
| [src/services/messages.ts](../src/services/messages.ts) | 376 | Canonical message objects, authors, media, forwarding, links and keyboards. |
| [src/services/phones.ts](../src/services/phones.ts) | 114 | Phone-number recognition and masking for exported text. |
| [src/services/resolve.ts](../src/services/resolve.ts) | 255 | Cached entity resolution, username/invite lookup and chat cards. |
| [src/services/search.ts](../src/services/search.ts) | 167 | Search within account categories, public hashtags and individual chats. |
| [src/services/stats.ts](../src/services/stats.ts) | 269 | Observed subscriber snapshots, album handling and public-counter statistics. |
| [src/services/topics.ts](../src/services/topics.ts) | 92 | Forum-topic listing and title filtering. |
| [src/services/write.ts](../src/services/write.ts) | 427 | Executors for send/reply/react/join/press, daily limits and outgoing-result parsing. |

### Storage

| File | Lines | Contents |
|---|---:|---|
| [src/storage/migrations.ts](../src/storage/migrations.ts) | 348 | Eight ordered schema migrations, including removal of the former automation schema. |
| [src/storage/port.ts](../src/storage/port.ts) | 175 | Storage interfaces and record types; a required type-only module. |
| [src/storage/sqlite.ts](../src/storage/sqlite.ts) | 558 | node:sqlite implementation, transactions, migrations and storage repositories. |

### Transport

| File | Lines | Contents |
|---|---:|---|
| [src/transport/http.ts](../src/transport/http.ts) | 180 | Local Streamable HTTP transport, bearer auth, host/origin checks and health endpoint. |
| [src/transport/stdio.ts](../src/transport/stdio.ts) | 155 | JSON-RPC forwarding to the daemon over HTTP, without owning Telegram sessions. |

### Write gate

| File | Lines | Contents |
|---|---:|---|
| [src/writegate/approvals.ts](../src/writegate/approvals.ts) | 169 | Write request preview, expiry, confirmation, rejection and execution outcomes. |
| [src/writegate/index.ts](../src/writegate/index.ts) | 112 | Write-gate composition, rechecked scopes and registered action executors. |
| [src/writegate/store.ts](../src/writegate/store.ts) | 164 | Approval persistence and executed-write journal used by daily limits. |

### Runtime

| File | Lines | Contents |
|---|---:|---|
| [src/runtime.ts](../src/runtime.ts) | 90 | Composes storage, account limiter, client pool, Telegram gateway and shutdown. |

### Tests

| File | Lines | Contents |
|---|---:|---|
| [src/cli/__tests__/cli.test.ts](../src/cli/__tests__/cli.test.ts) | 302 | Admin, login, doctor, locking/races and CLI routing. |
| [src/core/__tests__/chatId.test.ts](../src/core/__tests__/chatId.test.ts) | 43 | Canonical chat IDs and peer conversions. |
| [src/core/__tests__/entities.test.ts](../src/core/__tests__/entities.test.ts) | 86 | Entity normalization, harvesting and InputPeer construction. |
| [src/core/__tests__/errors.test.ts](../src/core/__tests__/errors.test.ts) | 131 | Wait extraction and error classification using real teleproto error classes. |
| [src/core/__tests__/limiter.test.ts](../src/core/__tests__/limiter.test.ts) | 349 | Queues, waits, slow mode, deadlines, hangs and fatal recovery. |
| [src/core/__tests__/misc.test.ts](../src/core/__tests__/misc.test.ts) | 99 | Crypto, logger/redaction, reactions and time helpers. |
| [src/core/__tests__/pool.test.ts](../src/core/__tests__/pool.test.ts) | 338 | Client pool, Telegram entry point, login, configuration and teleproto seams. |
| [src/mcp/__tests__/format.test.ts](../src/mcp/__tests__/format.test.ts) | 195 | Counters, dates, durations, messages, output limits and cursors. |
| [src/mcp/__tests__/tools.test.ts](../src/mcp/__tests__/tools.test.ts) | 480 | Tool contracts, account/scope security, errors, audit and owner scenarios. |
| [src/mcp/__tests__/toolsets.test.ts](../src/mcp/__tests__/toolsets.test.ts) | 703 | Dialogs, discovery, statistics, local index and toolset contracts. |
| [src/policy/__tests__/envelope.test.ts](../src/policy/__tests__/envelope.test.ts) | 51 | Untrusted-content boundaries, sanitization and Unicode behavior. |
| [src/policy/__tests__/policy.test.ts](../src/policy/__tests__/policy.test.ts) | 166 | User/account access, chat scopes, private modes and audit. |
| [src/services/__tests__/links.test.ts](../src/services/__tests__/links.test.ts) | 525 | Telegram references, rejects and message-link round trips. |
| [src/services/__tests__/media-jobs.test.ts](../src/services/__tests__/media-jobs.test.ts) | 349 | Media sizes, redirects/cache, export values and persisted jobs. |
| [src/services/__tests__/messages.test.ts](../src/services/__tests__/messages.test.ts) | 201 | Messages, hidden links, media and private-chat author identity. |
| [src/services/__tests__/phones.test.ts](../src/services/__tests__/phones.test.ts) | 67 | Phone masking and non-phone false positives. |
| [src/services/__tests__/read.test.ts](../src/services/__tests__/read.test.ts) | 410 | Resolution, history, search, comments and forum topics. |
| [src/storage/__tests__/sqlite.test.ts](../src/storage/__tests__/sqlite.test.ts) | 269 | Schema upgrades, obsolete-schema removal, accounts, sessions, cache, audit, jobs and transactions. |
| [src/transport/__tests__/transport.test.ts](../src/transport/__tests__/transport.test.ts) | 251 | HTTP security, MCP requests, stdio proxy and daemon lifecycle. |
| [src/writegate/__tests__/press.test.ts](../src/writegate/__tests__/press.test.ts) | 251 | Button output, supported/rejected types and two-step presses. |
| [src/writegate/__tests__/write.test.ts](../src/writegate/__tests__/write.test.ts) | 595 | Confirmation, scopes, expiry, idempotency, limits, reactions and write outcomes. |

### Shared test helpers

| File | Lines | Contents |
|---|---:|---|
| [src/__tests__/helpers/fakeTg.ts](../src/__tests__/helpers/fakeTg.ts) | 102 | Telegram test double with controlled calls/responses. |
| [src/__tests__/helpers/gateway.ts](../src/__tests__/helpers/gateway.ts) | 116 | In-memory test runtime, users/accounts and service assembly. |

## Local artifacts outside the main tracked snapshot

### Build output

Current production sources imply 192 emitted files: one `.js`, `.d.ts` and `.js.map` for each of 64 modules. All 192 are present. `dist/` additionally retains 42 outputs for 14 deleted modules. Running `npm run build` leaves these extras in place because the command invokes `tsc` without cleaning its output directory.

| Obsolete module prefix under dist/ | Extra files |
|---|---:|
| automation/approvals | 3 |
| automation/botApi | 3 |
| automation/index | 3 |
| automation/rules | 3 |
| automation/runner | 3 |
| automation/store | 3 |
| automation/taskStore | 3 |
| automation/tasks | 3 |
| automation/watcher | 3 |
| cli/runner | 3 |
| mcp/tools/automate | 3 |
| mcp/tools/confirm | 3 |
| mcp/tools/tasks | 3 |
| services/prices | 3 |

For every prefix, the three files are `.js`, `.d.ts` and `.js.map`. They have no current matching production source. The old automation implementation was removed from source before this review, including the pure-MCP change at `9b527bc`. These artifacts are not part of Git but are included by the current npm dry run.

### Registered nested worktree

`.claude/worktrees/gracious-williams-c8c91a` is a registered Git worktree, detached at `3bb040f3483d00c8ccd245df4f7f84c2d9810490`. Its working tree was clean at inspection. It is excluded by the local `.git/info/exclude` rule `.claude/worktrees/`, not by the committed `.gitignore`.

| Contents inside that older worktree | Regular files | Role |
|---|---:|---|
| src/ | 85 | Older project implementation, separate from current main |
| docs/ | 13 | Older documents, including prior-art and borrowing notes |
| scripts/ | 2 | Older installation/operational scripts |
| reference/ | 95 | Source snapshots from other repositories |
| dist/ | 189 | Its own generated build |
| node_modules/ | 4,879 | Its own installed dependencies |
| Other root files | 10 | Metadata, configuration, instructions and worktree Git pointer |

The 95 reference files comprise `reference/channel-scope/` (48), `reference/helper/` (43), `reference/canary/` (1), and `MANIFEST.txt`, `README.md`, `SNAPSHOT.md` (3). The root `reference/` was already removed from current main in commit `743c6f4`; it survives here in the older checkout.

A clean worktree does not establish that its owner no longer needs it. Any retirement should use Git's worktree lifecycle after the owner selects it, preserving needed state. Do not delete `.git` metadata or treat this checkout as an ordinary cache. Its source snapshots are not selected for the public transfer.

### Installed dependencies

Root `node_modules/` is ignored, generated installation material. It can be recreated from `package-lock.json` using `npm ci`; its absence would prevent local compilation/tests until reinstallation. The separate worktree has its own copy. Removing these directories would reclaim local space but would not simplify the tracked project source.

## npm package contents

A dry run after the build, using `npm pack --dry-run --ignore-scripts --json` with a temporary npm cache, selects **545 entries**, 884,371 compressed bytes and 3,877,819 uncompressed bytes. No package archive was written or published. These counts precede adding this report.

| Selected area | Entries |
|---|---:|
| .claude/worktrees/gracious-williams-c8c91a/ | 203 |
| dist/ | 234 |
| src/ | 87 |
| docs/ | 13 |
| scripts/ | 1 |
| Other root files | 7 |
| Total | 545 |

All 95 worktree reference files are selected, along with older project source/documents and a second lock file. Root/worktree `node_modules/` and the worktree's ignored build are excluded. The 234 main build entries include the 42 obsolete outputs listed above.

`package.json` has no `files` allowlist and no `.npmignore` exists. The local Git exclusion does not keep the nested checkout out of this npm package. `private: true` is the current publication guard; it does not prevent inspection or construction of a package archive.

Before public packaging, choose an explicit distribution manifest, build from a clean output directory and verify the actual tarball. Those changes have not been applied. Packaging an isolated snapshot also avoids picking up local worktrees, but it does not replace an explicit package-content check.

## Dependency inventory

| Direct dependency | Declared | Locked | Role | Lock-file license label |
|---|---|---|---|---|
| @modelcontextprotocol/sdk | ^1.31.0 | 1.31.0 | MCP server/transports and client test support | MIT |
| big-integer | ^1.6.52 | 1.6.52 | MTProto integer identities | Unlicense |
| teleproto | 1.229.1 | 1.229.1 | Telegram MTProto client, sessions and protocol types | MIT |
| zod | ^4.6.5 | 4.6.5 | Tool argument schemas | MIT |
| @types/node, development | ^22.18.0 | 22.20.4 | Node TypeScript declarations | MIT |
| typescript, development | ^5.9.3 | 5.9.3 | Compiler and type checking | Apache-2.0 |
| vitest, development | ^5.0.3 | 5.0.3 | Tests | MIT |

All four runtime dependencies are imported by current production source. `vitest` is used by tests/configuration; TypeScript and Node types support the configured compiler. None is an established removal candidate. There is no declared model SDK, external database driver or Bot API package.

The lock file records 168 dependency locations: 105 production and 63 development. These are locations, not a deduplicated count of package identities. All resolved archive URLs use the npm registry. The only `hasInstallScript` flag is the development dependency `fsevents` 2.3.3.

Production license labels are MIT (91), ISC (10), BSD-3-Clause (2), BSD-2-Clause (1) and Unlicense (1). Development labels are MIT (46), MPL-2.0 (12), Apache-2.0 (3), ISC (1) and BSD-3-Clause (1). Actual license texts, provenance and distributed notices still need the planned audit; these metadata counts do not settle redistribution obligations.

## Existing compatibility and historical material

- [migrations.ts](../src/storage/migrations.ts) contains eight ordered migrations. Earlier migrations create the former watchers/rules/task schema; migrations 6 and 7 remove it, and migration 8 removes the former reply cap. This is required upgrade history, not active automation. Existing migrations must remain intact under AGENTS.md; tests exercise upgrading old schema and dropping obsolete tables/columns.
- `RETIRED_TOOLSETS = ['automate']` in [config.ts](../src/core/config.ts) is used by parsing and [doctor.ts](../src/cli/doctor.ts). It keeps old configuration usable and emits a warning. CLI/config tests verify that behavior. Removing it would be a compatibility decision, not an obvious garbage deletion.
- Three headings in [sqlite.test.ts](../src/storage/__tests__/sqlite.test.ts) still call export/index jobs "tasks" (lines 214, 225 and 236). Their bodies use `storage.jobs`; renaming the headings would improve terminology without deleting tests or functionality.
- Version `0.1.0` appears both in package metadata and `src/cli/main.ts`. The MCP server name is currently `telegram-gateway`, while the selected future package/repository is `telegram-mcp-gateway` and the CLI remains `tg-mcp`. Align release metadata during its preparation stage; the first public version is still deferred.

## Documentation and publication preparation

The 13 documents serve different purposes. Architecture, tool contracts and general client instructions describe the product. Decisions, open questions, implementation evidence, naming research and the open-source plan contain owner/project preparation context. Deployment and parts of the client guide describe the current private lab. These roles overlap in places, especially the repeated preparation status, but are not byte-identical duplicates.

Choose public disposition file by file. Preserve current private operations and decision records while a public guide is prepared. The following require particular attention:

| Material | Existing locations | Public preparation concern |
|---|---|---|
| Lab host, user layout and personal usage | README, AGENTS, decisions, deploy, findings, use cases | Generalize or retain only explicitly selected public context |
| Root-owned private installation and GH_TOKEN | deploy, connect, lab-install.sh | Prepare a public installation path while retaining current private deployment |
| Local paths and profile examples | connect and deploy | Replace owner-specific examples with portable placeholders |
| Live capability evidence and limitations | plan, findings, tools | Retain accurate verified/partial status; update when the candidate is tested |
| Initial planning/research records | decisions, open questions, open-source plan, naming research | Keep private, condense, or select for publication; owner chooses |
| Agent-owned monitoring/conversation scenarios | use cases, scenarios, connect | Distinguish agent behavior from pure MCP; complete the planned public data/terms review |

The public files `LICENSE`, `.env.example`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` and `.github/` are absent. No third-party notice inventory exists; whether additional NOTICE material is necessary belongs to the licensing audit. Package metadata still uses the private name and `private: true`, and lacks `license`, `repository`, `homepage`, `bugs` and a `files` allowlist. These are preparation tasks, not files to delete.

The committed ignore rules do not explicitly exclude `session.key`, `.claude/worktrees/`, generic logs or backups. No protected secret/state filenames were found among the 110 tracked paths or main top-level entries. Actual Telegram state lives outside this checkout according to configuration and the deployment guide; it was not opened. Absence of secret filenames does not prove absence of embedded credentials or personal data.

This inventory report itself contains private operational paths and worktree details. It should remain a private preparation record unless the owner explicitly selects a sanitized public version.

## Cleanup options for owner selection

No option below has been executed. The choices distinguish deleting local artifacts, excluding material from publication and changing maintained source.

| ID | Scope | Evidence | Concrete option | Consequence or condition |
|---|---|---|---|---|
| C1 | Main dist/ | 42 orphan outputs for 14 removed modules; build preserves them | Recreate dist from current source and make release builds start clean | Generated files are removed/rebuilt; retain the 192 current outputs required by the CLI/package |
| C2 | Nested .claude worktree | Registered detached checkout, clean, older source and 95 reference files | Retire/archive the whole worktree if the owner no longer needs it | Use the Git worktree lifecycle; current main is independent, but cleanliness alone does not establish disposability |
| C3 | Root node_modules/ | Ignored and reproducible from the lock file | Keep for development, or remove/reinstall if local-space cleanup is wanted | No tracked-source simplification; build/tests need reinstallation |
| C4 | npm distribution | Dry run includes the old worktree and stale output | Add an explicit package allowlist and verify a clean build/tarball | Separate packaging change; decide whether source/declarations/maps/docs are intentionally distributed |
| C5 | Private documentation | Lab deployment, owner details and repeated planning status | Retain private records and select/generalize the public document set | Preserve accepted decisions and working private instructions; no blanket document deletion |
| C6 | Test terminology | Three SQLite headings say tasks while testing storage.jobs | Rename those headings to jobs | Text-only cleanup; preserve tests |
| C7 | Module exports | Some exported helpers are used only locally, all implementations remain referenced | Optionally reduce unnecessary exports in a separately reviewed change | Encapsulation work of low priority; not evidence that the functions should be deleted |
| C8 | Ignore rules | session.key and worktrees rely on missing/local-only exclusions | Add selected state/worktree/log/backup exclusions | Does not remove any data and does not replace the public-snapshot audit |

The current source, tests, dependency lock and migration history have no justified blanket deletion scope. Native Windows/Linux work, the installation model, the first public version, npm identity, licensing and CI remain separate preparation tasks. This review does not choose those deferred matters for the owner.

## Verification

| Check on the inspected source | Result |
|---|---|
| npm run build | Passed |
| npm run typecheck | Passed |
| npm test | 21 files, 694 tests passed |
| bash -n scripts/lab-install.sh | Passed; syntax only, installer not executed |
| Local Markdown link targets | All existing local targets resolve |
| Tracked-text Cyrillic and literal em dash scan | No matches in the 110 baseline files |
| Relative TypeScript import resolution | All resolved |
| Core/services imports from MCP or transport | None |
| Exact duplicate tracked-file hashes | None |
| npm dry-run file selection | Reproduced the 545-entry package and the inclusion problems above |

Windows/Linux runtime, actual installation of a tarball, full three-client scenarios, fresh Telegram writes, remote CI/settings and the full secret/license audit are not established by these checks. The current candidate-selection boundary is the owner's choice of cleanup scope.
