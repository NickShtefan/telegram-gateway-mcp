# Status and plan

Updated October 7, 2026. Live verification below reflects October 2 results; it was not repeated while preparing the open-source plan or repository inventory.

## Implemented

The gateway is implemented and installed on the lab machine: the daemon runs as `tgmcp`, the `agent` account is connected, and the gateway is registered in Claude Code (the owner's profile) and Hermes as `tg-gateway`. All five toolsets are enabled.

| Capability | Status |
|---|---|
| Reading: chat details, history, a message with context, comments, forum topics | Works on live Telegram |
| Search: account channels and groups, hashtags, within a chat | Works on live Telegram |
| Account dialog list | Works on live Telegram |
| File export, photo download | Works on live Telegram |
| Channel discovery, similar channels, forwarding sources | Works on live Telegram |
| Channel statistics | Works on live Telegram |
| Local indexing and search | Works on live Telegram |
| Private-chat mode (`scope private`), configurable daily limits | Verified on the live gateway |
| Private conversations: each message identifies its author, the peer or `this account` | Works on live Telegram |
| Write: direct message (`tg_send`, then `tg_confirm`) | Works on live Telegram |
| Write: reply under a post (`tg_reply`, then `tg_confirm`) | Works on live Telegram: the comment arrived; repeated confirmation does not send it twice |
| Write: reaction (`tg_react`, then `tg_confirm`) | Works on live Telegram: the reaction was added and replaced the account's previous reaction |
| Write: join (`tg_join`, then `tg_confirm`) | Works on live Telegram: the account joined a public supergroup |
| Write: send as a channel (`send_as`), remove a reaction | Verified through preview; no confirmed live action |
| Search accessible private chats (`where=private`) | Works on live Telegram |
| Reply to a specific comment or message (`reply_to`), link preview (`link_preview`) | Verified through preview; no confirmed live action |
| Forum topics: listing, title filtering, reading, searching within a topic | Works on live Telegram |
| Hidden links and inline buttons in full mode: position, label, type, link-button URL | Works on live Telegram |
| Inline button press (`tg_press_button`, then `tg_confirm`) | Live rejection cases verified (URL button, missing button, missing keyboard); no confirmed live callback press |

On October 2, 2026, 22 tools were exercised sequentially on the live gateway (all except the later `tg_press_button`): full reading, writes through preview with cancellation of every request.

Clients: the owner uses the gateway in Claude Code; the channel-summary scenario completed in Codex; Hermes connection and a tool call were verified; OpenCode connection was verified, but the lab machine lacks a model provider for the full scenario.

Tests: 694 tests using a Telegram double. Telegram errors use the library's real classes, and every request is serialized by those classes.

## Remaining owner tasks

1. In Claude Code, allow the whole `tg-gateway` server while keeping `tg_confirm` subject to a question ([connect.md](connect.md)).
2. Configure a schedule in the agent if channel monitoring or conversation management is needed ([connect.md](connect.md)).

## Open-source preparation

The [open-source plan](open-source-plan.md) covers owner decisions, private-repository cleanup and snapshot audit, licensing, general installation, CI and contributions, candidate verification, and publication. It was prepared from the code and GitHub settings on October 5, 2026, then updated with owner decisions. Build, typecheck, and all 694 tests passed on Node 24.10.0 during the initial review.

On October 5 the owner chose a clean new repository without private history, with further development there (decision 33), and MIT (decision 34). On October 6 the copyright line was agreed: `Copyright (c) 2026 NickShtefan`. The current repository remains private. Owner questions were reviewed one at a time; the owner concluded that review on October 6 after decisions 33 through 50. Snapshot audit, license files, and publication remain incomplete.

The October 6 [naming research](naming-research.md) examined GitHub and npm collisions, MCP Registry search, and platform guidance. The owner chose `telegram-mcp-gateway` and the public title `Unofficial Telegram MCP Gateway` (decision 35), npm publication in the first release (decision 36), the unscoped package name `telegram-mcp-gateway` (decision 37), and the personal repository `NickShtefan/telegram-mcp-gateway` (decision 38).

Decision 39 sets the order: clean the current private repository, audit and transfer a vetted snapshot into a new private repository, complete CI and release checks, then open access and publish to npm. General obsolete-code and artifact cleanup has not started.

An npm account is not confirmed: on October 6 the owner said they probably do not have one. Account verification or registration, email verification, and publishing authentication are planned before publication. The username is not selected yet; this is a release-preparation task.

macOS and Linux are selected for the first release, with Windows as a desired platform (decision 40). Windows must run natively and be tested on the owner's Windows computer (decision 41); WSL runs the Linux version. Official client documentation and platform-dependent gateway code have been inspected: the macOS installer, Unix-socket lock, and file-permission checks. Linux and Windows adaptation and testing have not been performed.

Decision 42 recommends Node 24 LTS, or a newer LTS after gateway verification, and supports Node 22 from 22.13. Official sources on October 6 list Node 24 as the latest LTS; Node 26 is Current, with LTS scheduled for October 28. Full matrix verification and environment updates belong to release preparation.

Decision 43 makes English the only repository language, with no Russian edition. Repository-wide translation includes documentation, agent instructions, comments, tests, examples, and scripts. Language cleanup is complete: documentation, comments, tool examples, tests, scripts, agent instructions, and .gitignore are English. All 110 tracked text files were scanned, with no remaining Cyrillic or literal em dash. Build, typecheck, all 694 tests in 21 files, installer syntax, and local documentation links passed on macOS with Node 24.10.0. Production-token comparison against the pre-translation commit found identical behavior in 62 files and only translated tool-description examples in two; SQL statements and filename character ranges remain equivalent. Unicode sanitization and accented full-text search coverage are retained. No lab deployment or live Telegram action was performed. Communication with the owner stays in Russian.

Decision 44 requires PRs, successful required checks, and owner-approved merges for all development in the new repository after the initial snapshot import, including owner/agent changes. It explicitly revises decision 19 for that repository; the current private repository retains its tested commit-and-push workflow. CI and branch protection remain unconfigured.

Decision 45 selects voluntary maintenance as the owner's time and capacity allow, without guaranteed reply or fix deadlines. Carry this policy into the future public README and contribution/security documentation.

Decision 46 selects GitHub private vulnerability reporting for the new repository. Enable and verify the form when opening access, and document the channel in the future `SECURITY.md`. The feature requires a public repository and explicit enablement; no GitHub setting was changed while recording this decision.

Decision 47 accepts external contributions under MIT with the PR author's confirmation that they have the right to submit the contribution under that license. No separate CLA or mandatory DCO sign-off is required. Prepare the public `CONTRIBUTING.md` and PR template under this policy, retaining provenance review and required third-party notices.

Decision 48 selects releases from a verified commit with prepared version metadata and release notes, followed by separate owner approval of the exact SHA and version. The tag, GitHub Release, and npm package must refer to that same commit. Document and implement the publishing procedure during preparation; no release was created while recording this decision. The first public version and stability designation, npm account, authentication, and publishing mechanism remain preparation questions.

Decision 49 selects a concise Code of Conduct: respectful communication, no insults, harassment, or spam, and moderation decisions by the owner. Prepare the public English `CODE_OF_CONDUCT.md` and link it from the contribution guide.

On October 6, the owner deferred choosing the first public version and stability designation. The proposed `0.1.0` is not accepted, and the current private package version does not select the public release version. Resolve the choice before release-candidate verification and publication; other preparation can continue.

Decision 50 retains `tg-mcp` as the public CLI command while the npm package and new repository use `telegram-mcp-gateway`. The existing bin entry already uses `tg-mcp`; preserve and verify it during public packaging and clean installation. No package metadata was changed or release published while recording this decision.

On October 6, the owner requested further consideration of the public installation model because frequent `sudo` use would be inconvenient. No public default or development-only restriction for same-user startup was accepted. Read-only review of the current installer and deployment guide confirms that ordinary MCP calls do not require `sudo`; installation, updates, and owner administration (login, users/accounts, scopes, doctor) do. The open-source plan compares the existing model, a proposed owner administration interface for an isolated daemon, and same-user execution. Evaluate usability, independent owner authorization, session/code protection, and platform feasibility before asking for a choice. No installer, permissions, deployed service, or lab policy was changed by this review.

The owner then closed the initial question review. The plan is ready as the preparation roadmap. Carry the deferred version and installation choices, npm setup, and scenario/terms review into their preparation stages rather than continuing the questionnaire. This closure records the end of planning discussion; no cleanup phase, migration, deployment, or publication was started by this step.

On October 7, the owner requested a full repository inventory before selecting cleanup scope. The [repository inventory and cleanup review](repository-audit.md) covers all 110 files at source SHA `66fb7e18ae64161322b0c0e4360dfec03a9d3ae3`, current module relationships, tests, dependencies, documentation, local artifacts, and npm file selection. All 64 production modules are reachable from the CLI, including the storage type contract. Main `dist/` retains 42 outputs from 14 deleted modules. A registered older worktree under `.claude/worktrees/` contains 95 reference snapshot files. The npm dry run includes 203 files from that worktree and all 42 obsolete outputs. Build, typecheck, 694 tests, installer syntax, local documentation links and language checks passed on macOS with Node 24.10.0. No cleanup or packaging fix was applied; the report records options for owner selection. No lab deployment or Telegram action was performed.

At the owner's request, the report was extended with a symbol and content review of all 87 source/test/helper files at SHA `8d9a917bbc01733d97f436538f0a7e4a7268e638`, including interfaces, callbacks, comments and the installer. No entirely unused own function, method, local variable or type was confirmed. It records two write-only error fields, two test-only repository access methods, 26 optional value exports, eight comment corrections and six behavior or policy findings. Isolated synthetic probes reproduced continued execution after a media timeout, duplicate local-search pages, incomplete full-media size enforcement, invalid log-level acceptance and two date-handling cases. ShellCheck passed. Cleanup and behavior changes remain for owner selection; no source, configuration, lab service or Telegram state was changed.

The owner then requested a cleanup plan based on the audit. The private [repository report](repository-audit.md) now contains the proposed sequence, scope and completion criteria: clean builds and explicit package exclusions, independent fixes for F1-F6, narrow symbol/comment cleanup, public transfer contents, final verification and snapshot preparation. The proposal retains test-only repository methods, working modules, tests and published migrations; worktree archiving is a separate optional item. Writing the plan does not start cleanup, deployment, migration or publication.

The owner authorized cleanup stages 1-5. Implementation and source selection are complete at `7a7600c32e29f8858107afbb4f59e454a2ffcc7c`: clean builds/package allowlist, F1-F6 regressions, two unused fields, 26 local exports, M1-M8 comments, synthetic fixtures and portable public docs. The [cleanup journal](cleanup-progress.md) records every implementation commit and verification. The [transfer manifest](public-transfer-manifest.json) selects 103 files, retaining private planning/evidence/lab operations separately. Build/typecheck, 726 tests, installer lint, links/language and isolated real archive installation pass. HTTP and stdio SDK scenarios pass. Full model-client compatibility remains open: expired Claude OAuth, Codex CLI model access rejection and absent local OpenCode. No deployment, live Telegram operation, worktree archive, transfer or publication occurred.

## Code structure

One private npm package, `telegram-gateway-mcp`, with the `tg-mcp` command.

```
tg-mcp/
├── src/
│   ├── core/         # client pool, limiter, watchdog, login, session encryption,
│   │                 # entity cache, errors, configuration, daemon lock, shared files
│   ├── storage/      # storage port, SQLite implementation, migrations
│   ├── policy/       # users, access, chat scopes, untrusted-text labels, audit
│   ├── services/     # links, resolver, reads, search, comments, topics, dialogs,
│   │                 # discovery, statistics, index, export, media, actions, jobs
│   ├── writegate/    # write requests, confirmation, limit journal
│   ├── mcp/          # tools, framework, formatting, cursors, argument parsing
│   ├── transport/    # Streamable HTTP and stdio proxy
│   ├── cli/          # serve, stdio, login, doctor, user, account, scope
│   └── runtime.ts    # core assembly: storage, limiter, pool, Telegram entry point
├── docs/
└── scripts/          # lab installer, snapshot updates
```

Tests are in adjacent `__tests__/` directories; shared Telegram doubles and the test gateway are in `src/__tests__/helpers/`. `core` and `services` do not import `mcp` or `transport`.

Layered architecture: [architecture.md](architecture.md).

## Ideas not started

All remain within pure MCP (decision 25). Implement only at the owner's request.

- Admin channel statistics (`stats.getBroadcastStats`): available for owned channels, not other people's channels.
- Reading public channels through any available account belonging to the user, rather than exhausting one account's limits.
- Reporting account freezes proactively in `tg_status` and `doctor` (currently the gateway discovers them only through Telegram errors).
