# Installation and updates

Lab installation under decisions 12/17 and local development startup. This is the existing private macOS deployment procedure, not a cross-platform public installer.

## Lab layout

| Path | Contents | Owner |
|---|---|---|
| `/opt/telegram-gateway-mcp/app` | Built code and dependencies | root |
| `/opt/telegram-gateway-mcp/node` | Separate Node 22 from nodejs.org | root |
| `/opt/telegram-gateway-mcp/install.sh` | Installer, run only from this location | root |
| `/opt/telegram-gateway-mcp/bin/tg-mcp` | Agent stdio command | root |
| `/opt/telegram-gateway-mcp/bin/tg-mcp-admin` | Owner login, user, account, scope, doctor commands | root |
| `/var/tgmcp/.tg-mcp` | Database, session encryption key, .env | tgmcp, mode 700 |
| `/opt/telegram-gateway-mcp/files` | Agent-readable exports and images | tgmcp, mode 755 |
| `/var/log/tg-mcp/daemon.log` | Daemon log | tgmcp |
| `/Library/LaunchDaemons/com.tg-mcp.gateway.plist` | launchd service | root |

Agents have shell access as nick, who also owns Homebrew and `/usr/local/bin/node`. Root-owned code and a separately downloaded, checksum-verified Node prevent an agent from replacing daemon executables and bypassing session isolation.

For the same reason, the installer never builds from agent-writable clones, dist, or node_modules. Root fetches the specified GitHub SHA, builds under `/var/root`, and installs the result. Select the SHA from GitHub or the main Mac, not the lab clone. The shared directory also lives under `/opt` to prevent planted symlinks in `/Users/Shared`.

Tradeoff: updates require sudo and owner execution.

## First installation

The owner performs every sudo step. Review [lab-install.sh](../scripts/lab-install.sh) before running it as root.

1. Create the root-owned directory and installer copy. This is the only step importing a file from the clone, so review it first:

```bash
sudo install -d -o root -g wheel /opt/telegram-gateway-mcp
sudo install -o root -g wheel -m 755 ~/tg-mcp-dev/scripts/lab-install.sh /opt/telegram-gateway-mcp/install.sh
```

2. Select a full commit SHA from GitHub or `git rev-parse origin/main` on the main Mac.

3. Install. Optionally import Telegram application credentials from an existing .env to avoid manual entry:

```bash
sudo GH_TOKEN="$(gh auth token)" TG_MCP_API_ENV=<credential-file-path> /opt/telegram-gateway-mcp/install.sh <full-commit-sha>
```

Only API_ID, API_HASH, and PHONE_NUMBER are read. The file is not executed; formats are validated and credential values are not printed. The phone number is used for the login-command hint. Without TG_MCP_API_ENV, edit the created template with `sudo -u tgmcp nano /var/tgmcp/.tg-mcp/.env`, then run `sudo launchctl kickstart -k system/com.tg-mcp.gateway`.

GH_TOKEN is needed while the repository is private. It is passed through Git's environment and never persisted.

The installer creates tgmcp, installs Node, builds code, installs the LaunchDaemon, waits for a health response, and prints these next steps:

1. Log into Telegram. The account holder enters their own code and 2FA password:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin login --account agent --phone <phone-number>
```

This creates a new gateway session. Other projects' sessions remain separate, but Telegram account limits apply across sessions.

2. Create gateway users and grant accounts. Tokens are printed once; only their hashes are stored:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user add nick --account agent
```

3. Verify:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin doctor
```

No restart is needed after login: the daemon loads the session on first use. Restart after .env changes. Create sessions independently on each machine; never copy them (decision 12).

## Writes

Initial installation enables only `TG_MCP_TOOLSETS=core`. Configure other toolsets in `/var/tgmcp/.tg-mcp/.env`. All read capabilities:

```
TG_MCP_TOOLSETS=core,discover,analytics,index
```

Add write for confirmed replies, messages, reactions, joins, and button presses:

```
TG_MCP_TOOLSETS=core,discover,analytics,index,write
```

To enable the read toolsets without an editor:

```bash
sudo -u tgmcp sed -i '' 's/^TG_MCP_TOOLSETS=.*/TG_MCP_TOOLSETS=core,discover,analytics,index/' /var/tgmcp/.tg-mcp/.env
sudo launchctl kickstart -k system/com.tg-mcp.gateway
```

### Daily write caps

Count actions per account per UTC day; exceeding a cap returns LIMIT_REACHED. Defaults: 20 post replies, 5 new conversations, 5 joins, 30 reactions. These are gateway choices, not Telegram thresholds (decision 27). Configure overrides in .env; 0 means unlimited. This example raises the new-conversation cap:

```
TG_MCP_LIMIT_NEW_DIALOGS=20
TG_MCP_LIMIT_REPLIES=20
TG_MCP_LIMIT_JOINS=5
TG_MCP_LIMIT_REACTIONS=30
```

Replace one setting without an editor:

```bash
sudo -u tgmcp sh -c 'f=/var/tgmcp/.tg-mcp/.env; grep -v "^TG_MCP_LIMIT_NEW_DIALOGS=" "$f" > "$f.new"; echo "TG_MCP_LIMIT_NEW_DIALOGS=20" >> "$f.new"; chmod 600 "$f.new"; mv "$f.new" "$f"'
```

Restart with kickstart. doctor reports effective values and identifies invalid variables; malformed numbers prevent startup.

The agent shows a preview, the owner consents, and the agent calls tg_confirm (decision 23). If the removed automate toolset remains configured, the gateway ignores it and doctor requests its removal.

## Updates

```bash
sudo GH_TOKEN="$(gh auth token)" /opt/telegram-gateway-mcp/install.sh <full-new-commit-sha>
```

Repeated installation updates code and restarts the daemon while preserving the user, .env, and sessions. The installed SHA is in `/opt/telegram-gateway-mcp/app/COMMIT`.

- Startup applies schema migrations. There is no downgrade path: older commits cannot use a newer schema.
- Interrupted export jobs return to the queue; a job interrupted for the third consecutive restart closes with an error.
- Interrupted confirmed actions are never retried. Their unknown outcome is visible through tg_confirm with the same approval_id; inspect Telegram yourself.
- If the installer changed, review its diff and refresh the root-owned copy with the first-installation command.
- During updates, logs over 10 MB rotate to daemon.log.1 with three old files retained. Between updates, launchd keeps the file open and no rotation occurs.

## Second user and shared accounts

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user add partner --account partner
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin account grant agent partner
```

The second person logs into their account independently with `tg-mcp-admin login --account partner`, receiving their own code.

Open a specific private conversation, which is closed by default:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin scope allow nick agent @username
```

Set send mode to allow messaging without reading. Alternatives: open for reading/writing all private chats, closed to restore defaults:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin scope private nick agent send
```

Modes are per user/account pair and apply immediately. Omit the final mode or use scope list nick agent to inspect the current setting.

## Agent connections

Use `http://127.0.0.1:7777/mcp` with `Authorization: Bearer <user-token>`. See [connect.md](connect.md) for client configurations.

## Development startup

On the main Mac, run from the clone without a separate service user. State lives in `~/.tg-mcp` or TG_MCP_HOME:

```bash
npm run build && node dist/cli/index.js doctor
node dist/cli/index.js serve --port 7777
```

Create an independent development session on this machine; never copy the lab session.

## Diagnostics

- doctor reports Node, directory permissions, credentials, users, accounts, and daemon health. --connect opens accounts only while the daemon is stopped; never start a second process on its sessions.
- `curl http://127.0.0.1:7777/healthz` returns `{"ok":true}` for a live daemon.
- tg_status reports account pauses and methods paused by long FLOOD_WAIT; other methods remain usable.
- Audit retention is 90 days, resolved approvals 7 days. Approval cleanup runs every minute, audit cleanup every six hours. No autonomous Telegram requests occur.
- Exit code 1 and `fatal MTProto failure` followed by restart are the intended response to a hanging MTProto call.
- `Another tg-mcp process already owns the Telegram sessions` indicates an existing daemon. Its lock is daemon.sock in the gateway directory.
