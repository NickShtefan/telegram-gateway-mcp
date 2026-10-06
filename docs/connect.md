# Connections and configuration

Start the gateway once; each client adds one server entry. Lab installation: [deploy.md](deploy.md). Examples assume `http://127.0.0.1:7777/mcp` and commands in `/opt/telegram-gateway-mcp/bin`.

Live lab evidence: Claude Code connected and used by the owner; Codex completed the channel-summary scenario; Hermes passed `hermes mcp add` and `hermes mcp test`. OpenCode connection only: the full run needs a model provider.

Do not use `npx tg-mcp`: that npm name belongs to another package (decision 14).

## Users and accounts

Gateway users, tokens, and account grants live in the daemon database and are managed by owner commands (decision 16), not a configuration file.

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user add nick --account agent
```

The token is printed once; only its hash is stored.

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user list
```

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin account grant agent partner
```

## Claude Code

Add the server to the user profile. The token is stored in that profile's `.claude.json` (mode 600).

```bash
claude mcp add --scope user --transport http tg-gateway http://127.0.0.1:7777/mcp \
  --header "Authorization: Bearer $(cat ~/.config/tg-mcp/token)"
```

- Any server name works. The lab uses `tg-gateway`, not `telegram`: a separate Claude Code bot plugin already uses `telegram` for owner communication. The distinct name avoids confusion. Tools are named `mcp__tg-gateway__tg_status`, etc.
- For multiple profiles, select one: `CLAUDE_CONFIG_DIR=/Users/nick/.claude claude mcp add ...`. The second user repeats setup in their own profile with their own token.
- Check `claude mcp list` for `tg-gateway ... Connected`. Restart existing sessions to load the server.
- To avoid prompts on every read, allow the server while keeping write confirmation subject to a question in profile `settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__tg-gateway"],
    "ask": ["mcp__tg-gateway__tg_confirm"]
  }
}
```

Headless configuration (`claude -p --mcp-config`):

```json
{
  "mcpServers": {
    "telegram": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer ${TG_MCP_TOKEN}" }
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`. Increase the tool timeout: exports wait up to 20 seconds before returning `job_id`.

```toml
[mcp_servers.telegram]
url = "http://127.0.0.1:7777/mcp"
bearer_token_env_var = "TG_MCP_TOKEN"
tool_timeout_sec = 90
```

One-off invocation without editing configuration (verified):

```bash
TG_MCP_TOKEN=... codex exec --skip-git-repo-check \
  -c 'mcp_servers.telegram.url="http://127.0.0.1:7777/mcp"' \
  -c 'mcp_servers.telegram.bearer_token_env_var="TG_MCP_TOKEN"' \
  "Call tg_status and tell me which accounts I have."
```

## OpenCode

Add to project `opencode.json` or global configuration (connection verified with `opencode mcp list`).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "telegram": {
      "type": "remote",
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer {env:TG_MCP_TOKEN}" }
    }
  }
}
```

The lab needs a model provider for `opencode run`; none is configured, and free models do not work non-interactively there.

## Hermes

Hermes stores the token in `~/.hermes/.env`, referenced by `config.yaml`. The variable name derives from the server name: `tg-gateway` gives `MCP_TG_GATEWAY_API_KEY`.

```bash
printf '\nMCP_TG_GATEWAY_API_KEY=%s\n' "$(cat ~/.config/tg-mcp/token)" >> ~/.hermes/.env
```

```bash
hermes mcp add tg-gateway --url http://127.0.0.1:7777/mcp --auth header
```

Answer yes to authentication. Hermes finds the `.env` token, shows tools, and offers to enable all. Resulting `config.yaml`:

```yaml
mcp_servers:
  tg-gateway:
    url: http://127.0.0.1:7777/mcp
    headers:
      Authorization: Bearer ${MCP_TG_GATEWAY_API_KEY}
    enabled: true
```

Check `hermes mcp test tg-gateway`. Tools appear in new Hermes sessions.

## Any stdio client

The proxy forwards to the daemon without opening sessions. Supply `TG_MCP_TOKEN`.

```json
{
  "command": "/opt/telegram-gateway-mcp/bin/tg-mcp",
  "args": ["stdio"],
  "env": { "TG_MCP_TOKEN": "<user token>" }
}
```

## Toolsets and writes

Daemon `.env` (`/var/tgmcp/.tg-mcp/.env`):

```
TG_MCP_TOOLSETS=core,discover,analytics,index,write
```

- `core`: reading/search, account dialogs; enabled by default.
- `discover`: channel name search, similar channels, forwarding sources.
- `analytics`: channel statistics.
- `index`: local chat indexing/search without Telegram rate limits.
- `write`: replies, messages, reactions, joins, and button presses; always two steps.

Each enabled toolset adds descriptions to the agent context. Enable what you use. Restart the daemon after `.env` changes ([deploy.md](deploy.md)).

Write flow: you ask for a reply, the agent calls `tg_reply` and shows its preview; you agree; the agent calls `tg_confirm`; the gateway sends it.

The gateway cannot observe whether the agent actually asked you. Keep `mcp__tg-gateway__tg_confirm` out of Claude Code's prompt-free allow list: the client must ask for every confirmation call. Other gateway tools can be allowed as a whole because they do not send messages directly.

## Monitoring and conversations belong to the agent

The pure MCP gateway (decision 25) neither watches channels, starts agents, nor manages negotiations. Configure ongoing tasks in the agent; the gateway exposes the same tools as in a conversation.

### Watch a channel

Give the agent a schedule (Hermes cron, Claude Code `/loop` or scheduled task). Example assignment:

```
Every 15 minutes, call tg_read_history for @channel with limit=5.
Compare the newest post ID to the one remembered from the previous run.
Read new posts (tg_get_message, plus tg_get_media for images)
and send me a short summary. Stay silent when there are no new posts.
```

The agent remembers the last post. The gateway supplies history; it does not watch or initiate anything.

### Prepare post replies

```
When a new post appears in @channel, prepare a reply through tg_reply
and show me the preview. Send through tg_confirm only after I say yes.
```

Requests expire in 30 minutes. If you respond later, the agent prepares a new one. The gateway enforces the daily reply cap (default 20) and prevents a second draft for the same post while the first waits for your decision.

### Negotiate with a person

1. Open the dialog (private chats are closed by default):

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin scope allow nick agent @username
```

If opening each peer separately is inconvenient, permit sending to anyone without reading conversations:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin scope private nick agent send
```

`open` also allows reading every private chat on the account; `closed` restores individual grants. The command applies immediately without restart. `tg_status` shows the mode.

2. Explain the goal/boundaries in the conversation; the agent stores them in its memory. It drafts with `tg_send`; you confirm each message.
3. The agent reads replies with `tg_read_history` when asked or on its own schedule.

Close the dialog again: `tg-mcp-admin scope remove nick agent @username`.

The default new-peer cap is five per day. It is a gateway setting, not a Telegram rule: set `TG_MCP_LIMIT_NEW_DIALOGS=<number>` in daemon `.env`; 0 disables it ([deploy.md](deploy.md)).
