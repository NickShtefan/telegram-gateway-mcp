# Verified findings

Historical findings from gateway development about Telegram, libraries, clients, and the lab machine. Unless qualified, each was checked through code or execution at the time of recording. This translation does not repeat those live checks.

## Telegram and MTProto

- **Global search:** messages.SearchGlobal searches account chats, not all Telegram. nextRate, rather than page fullness, indicates continuation.
- **Hashtag search:** channels.SearchPosts searches public channel posts and accepts a hashtag.
- **Reading without joining:** public channel/group history, chat search, and comments are readable without membership.
- **Comments:** live in the linked discussion group. messages.GetDiscussionMessage returns a post copy whose fwdFrom.savedFromMsgId identifies the source post. GetReplies reads pages of 100. MSG_ID_INVALID indicates disabled comments/deleted posts; CHANNEL_PRIVATE indicates inaccessible private discussion groups.
- **Forum topics:** messages.GetForumTopics moved from channels in layer 229; GetReplies reads topics by ID.
- **accessHash:** session-specific; never share caches between accounts.
- **messages.GetMessages:** searches IDs across private chats and basic groups; filter results to the requested chat.
- **Recommendations:** non-Premium accounts receive only some channels, with a reported total count.
- **Long FLOOD_WAIT:** method-specific, such as contacts.ResolveUsername for a day, while other methods work.
- **Join outcomes reported as errors:** INVITE_REQUEST_SENT and USER_ALREADY_PARTICIPANT are successful outcomes.
- **RANDOM_ID_DUPLICATE:** a previous send attempt already delivered the message.
- **Keyboard reactions:** hearts include a variation selector that Telegram's reaction form omits.
- **Invisible hidden links:** scheduled-post services such as controller.bot put image URLs under a zero-width character to produce previews, leaving no visible link label.
- **Inline buttons, layer 229:** ReplyInlineMarkup contains KeyboardInlineButtonRow and KeyboardInlineButton; its type holds InlineButtonTypeCallback, InlineButtonTypeUrl, and other kinds. Parsing was verified on live channel posts. Pressing uses messages.GetBotCallbackAnswer with message-supplied bytes; a live press has not been verified.
- **send_as:** messages.SendMessage supports it; live channel-identity discussion replies remain unverified.
- **PEER_FLOOD:** Telegram does not publish stranger-message thresholds; their practical values were not tested.

## teleproto 1.229.1

- GramJS fork using protocol layer 229 with a compatible session-string format.
- Server error codes appear in errorMessage (such as FLOOD_WAIT_42), timing in seconds, and human-readable wording in message.
- Default logging uses console.log/stdout; the gateway replaces it.
- Close with destroy(), not disconnect(), to stop the update loop.
- The update loop may emit TIMEOUT outside handlers; the daemon suppresses that specific error.
- client.start() can register an unknown phone number automatically unless name requests are intercepted; the gateway aborts.
- downloadMedia thumb accepts a size letter; m is around 320 px.
- Network failures may hang indefinitely, inherited from GramJS; enforce an external deadline.

## Node and SQLite

- node:sqlite works from Node 22.13. FTS5 trigram is available on both machines; ALTER TABLE DROP COLUMN is supported.
- macOS Unix socket paths have a 104-byte limit. daemon.sock resides under the gateway directory; long TG_MCP_HOME paths fail with a shorter-path hint. `/var/tgmcp/.tg-mcp` is short enough.
- setTimeout delays over 2^31-1 ms fire immediately; cap long waits.

## Clients

- **Claude Code:** `claude mcp add --scope user --transport http <name> <url> --header "Authorization: Bearer ..."` saves the server in the user profile. Headless execution accepts --mcp-config with type http and headers. Lab SSH claude -p cannot authenticate because its OAuth token resides in an inaccessible keychain.
- **Codex:** mcp_servers entries use url, bearer_token_env_var, and tool_timeout_sec; codex exec -c accepts the same settings. Streamable HTTP works.
- **OpenCode:** remote servers use type remote, url, and headers with `{env:...}` substitutions. Lab opencode run has no model provider configured.
- **Hermes:** `hermes mcp add <name> --url ... --auth header` stores the token in ~/.hermes/.env under a server-derived name and references it from config.yaml.

## Lab machine

- nick@macbook-pro-lab.local: macOS 15.7, Intel x86_64, Node 22.22. Installed clients: claude, codex, opencode, hermes, gh.
- The owner's Claude Code talks through its official Telegram plugin (Bot API), separately from this gateway. That plugin uses server name telegram, so this gateway is connected as tg-gateway.
- Homebrew and /usr/local/bin/node belong to nick. The daemon uses its own Node under /opt/telegram-gateway-mcp/node.
