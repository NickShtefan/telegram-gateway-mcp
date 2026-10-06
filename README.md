# tg-mcp

An MCP gateway to Telegram. One daemon owns the sessions of connected Telegram accounts and exposes them to agents (Claude Code, Hermes, Codex, OpenCode, or any MCP client) as tools: reading channels, groups, and comments; searching; exporting files; fetching images; discovering channels; retrieving statistics; local indexing; and writes with confirmation.

The gateway is a tool for an agent, not an agent (decision 25). It does nothing until an agent calls a tool: it does not watch chats, run models, or manage tasks. There is no model or model API key inside. The agent produces summaries, calculations, and text; it can also watch channels or manage conversations using its own schedule and memory.

## Capabilities

23 tools in five toolsets. Enable toolsets through `TG_MCP_TOOLSETS`; only `core` is enabled by default.

| Toolset | Tools | Capabilities |
|---|---|---|
| `core` | `tg_status`, `tg_list_dialogs`, `tg_resolve`, `tg_search_messages`, `tg_search_chat`, `tg_read_history`, `tg_get_message`, `tg_get_comments`, `tg_list_topics`, `tg_export`, `tg_get_media` | Reading and searching: account dialogs, chat details, history, comments, forum topics, JSONL or CSV export, photos and albums |
| `discover` | `tg_find_channels`, `tg_similar_channels`, `tg_forward_sources` | Channel search by name, similar channels, forwarding sources |
| `analytics` | `tg_channel_stats` | Channel metrics: subscribers, reach, engagement, trend |
| `index` | `tg_index`, `tg_local_search` | A local chat index and search without Telegram requests |
| `write` | `tg_reply`, `tg_send`, `tg_react`, `tg_join`, `tg_press_button`, `tg_confirm` | Comment replies, messages, reactions, joins, and bot button presses: always in two steps |

Details: [docs/tools.md](docs/tools.md).

## Main properties

- **One process owns the sessions.** The daemon listens on `127.0.0.1`. Each gateway user has a bearer token and sees only their own and shared accounts.
- **Writes in two steps.** A write tool returns a preview and `approval_id`. The action reaches Telegram only after `tg_confirm`, which the agent calls after the owner's consent.
- **Private chats are closed by default.** The owner opens access with a command: one dialog, send-only or read-and-send. Telegram service chats remain closed.
- **Untrusted text is labeled.** Telegram text is wrapped in markers in tool responses: it is data, not instructions to the agent.
- **Account limits.** Every MTProto call goes through the account queue with a deadline. FLOOD_WAIT is returned as an error with `retry_after`; writes have daily limits.
- **All state in one SQLite file.** No external storage services.

Internals: [docs/architecture.md](docs/architecture.md).

## Status

- Installed on the lab machine `macbook-pro-lab.local` under a separate macOS user, connected to Claude Code and Hermes. Two people use it: the owner and the owner's wife. Each has personal Telegram accounts, and some accounts are shared.
- Reading has been verified on live Telegram across all toolsets. Confirmed writes include sending a message, replying to a post, reacting, and joining a public supergroup. The exact verification status and remaining gaps are in [docs/plan.md](docs/plan.md).
- The current repository is private (`telegram-gateway-mcp`); the package is not published to npm. Do not run `npx tg-mcp`: that npm name belongs to someone else's package.
- Open-source preparation targets a clean new repository and the npm package `telegram-mcp-gateway`. The release has not been published. See [docs/open-source-plan.md](docs/open-source-plan.md).

Details: [docs/plan.md](docs/plan.md).

## Directory map

| Path | Contents |
|---|---|
| [AGENTS.md](AGENTS.md) | Instructions for any agent working in this directory. Read first. |
| [CLAUDE.md](CLAUDE.md) | Loads AGENTS.md for Claude Code. |
| [docs/tools.md](docs/tools.md) | Tools: behavior, contracts, writes, and private chats. |
| [docs/architecture.md](docs/architecture.md) | Request flow, layers, services, core, and database tables. |
| [docs/decisions.md](docs/decisions.md) | Current decisions and their rationale. |
| [docs/connect.md](docs/connect.md) | Client connections, toolsets, and agent-owned monitoring and conversations. |
| [docs/deploy.md](docs/deploy.md) | Lab installation, updates, configuration, and diagnostics. |
| [docs/use-cases.md](docs/use-cases.md) | Four owner tasks and what each needs from the gateway. |
| [docs/scenarios.md](docs/scenarios.md) | The same tasks, step by step. |
| [docs/risks.md](docs/risks.md) | Risks ordered by impact. |
| [docs/plan.md](docs/plan.md) | Implementation, verification evidence, and remaining work. |
| [docs/open-source-plan.md](docs/open-source-plan.md) | Open-source preparation: stages, owner decisions, and publication gates. |
| [docs/naming-research.md](docs/naming-research.md) | Human and agent search research supporting decision 35. |
| [docs/open-questions.md](docs/open-questions.md) | Unresolved questions. |
| [docs/findings.md](docs/findings.md) | Verified facts about Telegram, the library, and clients. |
| `src/` | Code: `core`, `storage`, `policy`, `services`, `writegate`, `mcp`, `transport`, `cli`. |
| [scripts/lab-install.sh](scripts/lab-install.sh) | Installation under a separate macOS user (run by the owner; requires sudo). |

## Development quick start

```bash
npm ci && npm run build && npm test
```

```bash
node dist/cli/index.js help
```

State lives in `~/.tg-mcp` (or `TG_MCP_HOME`). Put your own Telegram application credentials in `<directory>/.env` as `TG_API_ID` and `TG_API_HASH`.
