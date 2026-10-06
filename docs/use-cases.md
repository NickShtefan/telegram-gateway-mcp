# Use cases

Owner-requested tasks from 2026-10-01. See [scenarios.md](scenarios.md) for detailed flows.

The pure MCP gateway responds to calls and executes confirmed actions (decision 25). One-off cases 1/2 fit one agent conversation; ongoing cases 3/4 require agent-owned scheduling and memory, using the same gateway tools.

## 1. Marketplace prices: one-off

> Find listings for this item in the marketplace and analyze prices.

Flow: tg_list_dialogs -> tg_list_topics -> tg_search_chat -> tg_export (photos=thumb) -> agent code -> tg_get_media.

- **Forum topics:** distinguish Selling, Buying, and Exchange through topic filters in search/history/export.
- **File export:** JSONL path, row count, and five examples avoid putting hundreds of listings into model context. Agent code calculates medians and dispersion.
- **Price interpretation:** original listing text remains unchanged; agents parse 25k, 25,000 RUB, and negotiable. Authors are hashed and phones masked.
- **Images:** export previews in batches and request full albums to inspect item condition.
- **Private chats:** joining requires confirmation. Gatekeeper challenges are completed manually or through an owner-approved callback press.

## 2. Channel summary: one-off

> Open this channel and explain what people discuss.

Flow: tg_resolve -> tg_read_history (brief) -> tg_get_message for five posts -> tg_get_media -> tg_get_comments for five posts.

- Brief history uses one or two lines per post plus views, reactions, and comment counts.
- Top comments are ranked by reactions.
- Images expose chart/screenshot details.
- Untrusted-content boundaries prevent treating comment instructions as commands.

## 3. Monitoring and comments: agent-owned

> Watch this channel and prepare replies when new posts appear.

The gateway never monitors or replies autonomously.

- The agent's own schedule or loop initiates checks.
- Read history and compare remembered IDs, or pass since.
- Read new posts, images, and comments; prepare tg_reply; show the owner its preview and call tg_confirm after consent.

Gateway capabilities: history, images, comments, thread replies from the account or send_as identity, and daily reply caps (default 20). Live send_as verification remains pending.

## 4. Conversations and agreements: agent-owned

> Contact this account and arrange the proposed agreement.

The agent retains goals, constraints, and conversation state.

- The owner opens specific conversations with `tg-mcp-admin scope allow <user> <account> @username`. Private chats are closed by default. scope private send allows sending without reading; open allows both.
- Prepare tg_send, show the preview, obtain consent, and execute tg_confirm.
- Read replies when requested or on the agent's own schedule.
- Ask the owner about money, addresses, and meeting times in the agent conversation.

The gateway provides authorized conversation reads and two-step sends with a configurable new-conversation cap (default 5/day). It has no money-transfer capability. tg_confirm enforces the workflow step, not independently verified human approval.

## Shared requirement: images

All cases may download photos, albums by groupedId, and video previews. thumb is default; full requires a request. Return paths or inline images for compatible clients. Previews conserve model context.

## Shared requirement: multiple users

The owner and the owner's wife use separate Claude Code sessions with personal and shared Telegram accounts. Bearer tokens identify users and restrict account access; each confirms their own write requests through their own agent (decisions 16/23).

## Writing identity: decided

Use the connected Telegram account, whether a separate agent account or an explicitly connected owner account. Administrators may use send_as for channel identity. Select among multiple accounts with the account argument.
