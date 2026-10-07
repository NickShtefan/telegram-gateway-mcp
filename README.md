# Unofficial Telegram MCP Gateway

An MCP gateway for Telegram user accounts. One daemon owns the MTProto sessions and exposes tools to Claude Code, Codex, OpenCode and other MCP clients. Agents can read and search chats, fetch media, export messages, inspect channel counters, build a local index and prepare confirmed writes.

The gateway is a tool for an agent. It does not run models, watch chats, start agents or manage negotiation goals. Every Telegram operation begins with a tool call. This project is independent of Telegram.

## Capabilities

23 tools in five toolsets; `core` is enabled by default.

| Toolset | Capabilities |
| --- | --- |
| core | Account dialogs, chat resolution, search, history, comments, forum topics, JSONL/CSV exports, photos and previews |
| discover | Channel name search, similar channels and forwarding sources |
| analytics | Public channel counters, reach, engagement and trends |
| index | Explicit chat indexing and local substring search without Telegram calls |
| write | Preview and confirm replies, sends, reactions, joins and callback button presses |

One process owns each session. Bearer tokens separate gateway users and their account grants. Private conversations are closed by default. Every MTProto call passes through an account queue with limits and a deadline. A hung operation stops queued work and exits with code 1 for supervisor restart. Telegram text is labeled as untrusted data.

Write tools return a preview and `approval_id`. The agent must show it to the owner and call `tg_confirm` only after consent. The gateway cannot independently verify human approval; client permissions are part of this boundary.

## Preparation status

The current repository and package remain private and unpublished. The selected public repository and npm name is `telegram-mcp-gateway`; the command stays `tg-mcp`. Do not run `npx tg-mcp`: that package belongs to a different project.

MIT is the selected license; the license file, provenance review and any required notices are still release gates. Public installation will use a separate service identity with convenient owner management. That workflow is not implemented yet. The selected first public version is 0.2.0. Release targets are macOS 13+ (arm64/Intel), Linux and native Windows; qualification is pending. The terminal installer has no paid Apple Developer dependency. No production installation recommendation is implied by the development commands below.

## Development

Requires Node.js 22.13 or later and npm. The release policy is to recommend a tested LTS branch and verify the minimum Node version separately. Cleanup checks currently run on macOS with Node 24.10.0.

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
node dist/cli/index.js help
```

The build removes old outputs before compiling. The npm archive contains JavaScript, declarations, this README and license notices when provided; tests, source maps, private records and runtime state are excluded.

State defaults to `~/.tg-mcp`, or `TG_MCP_HOME`. Use only sessions created by this gateway's own login, separately on each machine. Never share session strings with another process or project. Store credentials, database and session key outside the checkout and away from agents with shell access.

## Source directory map

| Path | Contents |
| --- | --- |
| src/core | Session pool, limiter, watchdog, configuration, login and file safety |
| src/storage | SQLite implementation, interfaces and immutable migrations |
| src/services | Reads, search, export, media, index, statistics and actions |
| src/policy, src/writegate | User access, scopes, untrusted content, audit and write confirmation |
| src/mcp, src/transport | MCP tools, compact responses, HTTP server and stdio proxy |
| src/cli | Owner administration and daemon commands |
| docs | Architecture, tool contracts, connections, risks and synthetic scenarios |

The source checkout contains the detailed documents; they are not part of the runtime npm archive. Contributor agent instructions live in `AGENTS.md`.

Read-only `tg-mcp setup preflight` and cached `setup status` plus a shared setup engine are implemented; see the [setup foundation](docs/setup.md). The no-Node terminal installer and owner/service/client adapters remain unfinished, so this is not a complete installation workflow.
