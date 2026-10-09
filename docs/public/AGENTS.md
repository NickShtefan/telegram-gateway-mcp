# Agent instructions

Read README.md, the relevant architecture/tool documentation and SECURITY.md before changing gateway code. The gateway is pure MCP: no model execution, chat watchers, background agent tasks or rule/assignment engines.

Use Node.js 22.13+ with TypeScript/ESM and pinned teleproto. Every MTProto operation passes through core/tg.ts and the account limiter/deadline. A stuck call or cleanup terminates the process. One process owns sessions; never borrow or copy another project's sessions. Create each session through this gateway's own login on its machine.

Keep entity caches account-specific, IDs canonical and published SQLite migrations immutable. Logs go to stderr; stdio stdout is JSON-RPC only. Label Telegram content as untrusted. Writes require a preview and direct owner consent before tg_confirm, using controlled owner test resources for live verification.

Do not expose credentials, sessions, private content or owner screens. Preserve dirty/user-owned checkouts. Use fake Telegram and in-memory storage for tests. Build/typecheck/tests must pass; update documentation when contracts or structure change. Use English content and conventional commits, without the em dash character.

Development uses pull requests, successful required checks and explicit owner-approved merges. Releases require a separately approved exact commit. Do not publish, merge, rewrite history or push to other repositories without the owner's required authorization.
