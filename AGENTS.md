# AGENTS.md: tg-mcp

Instructions for any agent (Claude Code, Codex, OpenCode, Hermes) working in this directory.

## Project

tg-mcp is an MCP gateway to Telegram. One daemon owns the MTProto sessions of connected accounts and exposes them to agents as MCP tools. Documentation is in `docs/`, code in `src/`. Implemented features and verification evidence are recorded in `docs/plan.md`.

## Environment

- The gateway daemon runs on the lab machine `nick@macbook-pro-lab.local` (macOS, Intel, Node 22), alongside the agents. Development takes place on the main Mac.
- Create a Telegram session by logging in separately on each machine. Never copy sessions between machines.
- Two people use the gateway (the owner and the owner's wife). Each has personal Telegram accounts, and some accounts are shared (decision 16 in `docs/decisions.md`).
- The current repository is private, `telegram-gateway-mcp`. Do not run `npx tg-mcp`: that npm name belongs to someone else's package.

## Reading order

1. `README.md`: purpose, capabilities, and directory map.
2. `docs/decisions.md`: accepted decisions and their rationale. Do not silently revisit them; explicitly propose a change when warranted.
3. `docs/open-questions.md`: unresolved questions. Do not decide them for the owner.
4. `docs/plan.md`: implementation status and code structure.
5. `docs/architecture.md` and `docs/tools.md`: gateway internals and the agent-facing interface. Find the relevant section before changing a gateway component.

## Language and style

- All repository content must be in English: documentation, comments, tool and CLI text, tests, examples, scripts, agent instructions, and new commit messages. Do not maintain a Russian edition (decision 43).
- Communication with the owner remains in Russian unless requested otherwise.
- Never use the em dash character (U+2014) in text, code, or commits. Use a colon, comma, parentheses, or rephrase. Regular hyphens in compound words are allowed.
- Use conventional commits (`feat(scope): ...`, `fix: ...`).

## Hard constraints

- **Pure MCP.** The gateway is a tool for an agent, not an agent (decision 25). It does nothing without a tool call: no chat watching, model execution, model task generation, rule or assignment management, or interpretation of data for the agent. Do not add background watchers, schedulers, `claude -p` execution, or similar features without the owner's direct request.
- **Own sessions.** Only use sessions created through the gateway's own login (`tg-mcp-admin login`). Never borrow session strings or bot tokens from other projects: a second client on a borrowed session can trigger `AUTH_KEY_DUPLICATED`, causing Telegram to revoke it.
- **One process per session.** Never create a second MTProto client on the same session, in this process or another. The stdio mode either proxies to the running daemon or acquires the session lock.
- **Secrets.** Never print or copy `.env`, sessions, bot tokens, `API_HASH`, or connection strings containing passwords. Never put secrets in `docs/` or tests.
- **Other repositories are read-only.** Do not change another project's code from this directory without an explicit request from the owner.
- **Telegram writes.** Write tools (join, react, reply, send, press a button) must use the write gate: preview first, then `tg_confirm` after the owner's consent (decision 23). Verify writes only on the owner's channel and test account, never on other people or chats.
- **Never:** transfer money, send bulk messages, join chats in bulk, or message strangers without the owner's explicit consent.
- **Logs only to stderr.** Any stdout line in stdio mode breaks JSON-RPC. This includes the MTProto library logger, which uses `console.log` by default.
- **Commits and pushes.** Under decision 19 in `docs/decisions.md` (2026-10-01), commit after each completed step with green tests and push to `main` of the current private repository. After the initial snapshot import, development in the new repository uses PRs with successful required checks and owner-approved merges (decision 44); agents must obtain explicit owner approval before merging and must not push development changes directly to its `main`. Force pushes, history rewrites, and pushes to other repositories require the owner's explicit request.

## Technology

- Node.js 22+, TypeScript, ESM. See decision 42 for the public release's LTS policy.
- teleproto for MTProto (decision 26): a maintained GramJS fork, pinned to an exact version. The `telegram` package (GramJS) is archived; do not reinstall it. Update teleproto deliberately: review changes, run tests, and verify a live account. The gateway does not use the Bot API; there is no approval bot (decision 23).
- `@modelcontextprotocol/sdk` and `zod` for MCP.
- SQLite storage with `node:sqlite` (decision 19). Change the schema only through a new migration in `src/storage/migrations.ts`; never edit published migrations.
- vitest, with tests in adjacent `__tests__/` directories. Replace Telegram with the test double in `src/__tests__/helpers/fakeTg.ts`, use an in-memory database, and inject dependencies explicitly.

## Code rules

- Every MTProto call goes through `core/tg.ts` (limiter and deadline). No direct `client.invoke` calls bypassing the queue.
- Do not attempt in-process recovery of a stuck MTProto call: exit with code 1 and let the supervisor restart the process.
- Return FLOOD_WAIT above the threshold as an error with `retry_after`; do not wait it out.
- accessHash belongs to a session: cache entities separately for each account.
- Store chat IDs in one canonical form; convert between `-100...` and MTProto through `core/chatId.ts`.
- Treat every Telegram text as untrusted content and label it in tool responses.

## Definition of done

- `npm run build` and `npm test` pass.
- For MCP tools, the same prompt from `docs/scenarios.md` works consistently in `claude -p`, `codex exec`, and `opencode run`.
- Update `docs/` when decisions, tools, or structure change.
