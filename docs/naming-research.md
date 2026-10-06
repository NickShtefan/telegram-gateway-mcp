# Naming for organic discovery

Researched on 2026-10-06, Cyprus time. The owner accepted the recommendation that day (decision 35).

Selected repository identifier: **telegram-mcp-gateway**. Display title: **Unofficial Telegram MCP Gateway**. Telegram and MCP identify the category; gateway describes one daemon providing agents with account access. The exact name had fewer collisions than tg-mcp and telegram-mcp. Keeping the telegram-mcp substring has a verifiable advantage in the official MCP Registry.

This assesses clarity and discoverability, not measured query volume, future traffic, or Google ranking. A name alone does not ensure agent recommendations.

## Human search

Queries used in research represent intentions, not a popularity ranking.

| Intent | Example queries | Project listing should explain |
|---|---|---|
| Already knows MCP | telegram mcp server; MCP server for reading Telegram messages | Telegram, MCP server, reading/search |
| Connect an agent | read Telegram messages with Claude MCP; connect Telegram to Codex MCP | Agents receive Telegram access tools |
| Find a capability | Telegram MCP multi account | Multiple accounts, one daemon, access control |
| Find this project | telegram-mcp-gateway | Distinct name and repository link |

Generic results mix opposite integration directions. [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) exposes Telegram through MCP; [patriceac/codex-telegram](https://github.com/patriceac/codex-telegram) controls Codex from Telegram. Our description must explicitly say that agents read/search through connected Telegram accounts. Bridge alone does not explain direction.

GitHub repository search considers names, descriptions, and topics; README search requires in:readme. Put relevant words in listing metadata too. Source: [GitHub repository search](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories).

Google recommends concise descriptive titles without keyword stuffing. This supports a descriptive name but does not prove better ranking for telegram-mcp-gateway versus telegram-gateway-mcp. Source: [Google title links](https://developers.google.com/search/docs/appearance/title-link).

## Agent search

Web search, GitHub, the official MCP Registry, and third-party catalogs behave differently.

The official Registry search parameter matches a **case-insensitive substring in server names**, not description semantics. The comparison below assumes registration under a name containing the listed identifier. Source: [Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md).

| Identifier within server name | search=telegram | search=telegram-mcp |
|---|---|---|
| tg-mcp | No | No |
| telegram-gateway-mcp | Yes | No |
| telegram-mcp-gateway | Yes | Yes |
| unofficial-telegram-mcp-gateway | Yes | Yes |

A live API check with version=latest&limit=100 returned four entries for telegram-mcp and seven for tg-mcp. All seven latter names contained other combinations, such as prtg-mcp, mtg-mcp, and btg-mcp. Both result sets were complete without continuation pages. This demonstrates abbreviation noise, not Telegram demand.

GitHub-based publication requires the io.github.<username>/... namespace. A possible identifier is io.github.NickShtefan/telegram-mcp-gateway. title, description, repository, and installation fields help clients understand results. Registration remains future work. Sources: [Registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx), [server.json format](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md).

No universal agent-web-search ranking rule was verified. Google's AI Overviews and AI Mode use ordinary SEO foundations without special AI files or markup; this statement applies to Google, not all agents. Source: [Google AI features](https://developers.google.com/search/docs/appearance/ai-features).

## Candidate comparison

| Name | Observed collisions | Assessment |
|---|---|---|
| tg-mcp | Existing npm package by another author | Short abbreviation hides Telegram and risks installing the wrong package |
| telegram-mcp | Existing GitHub projects and npm package | Clear category, weak project distinction |
| telegram-gateway-mcp | No public GitHub project/npm package found | Clear, but lacks the telegram-mcp substring |
| **telegram-mcp-gateway** | No public GitHub project/npm package found | Best balance of clarity, distinction, and Registry search |
| telegram-mcp-bridge | Existing GitHub projects; no npm package found | Mixed Telegram-reading and agent-control meanings |
| telegram-user-mcp | Existing GitHub projects and npm package | Specifies account type, but occupied and user is ambiguous |
| unofficial-telegram-mcp-gateway | No public GitHub project/npm package found | Longer, retains both search substrings and Unofficial in the identifier |

Gateway is not a unique feature: [fast-mcp-telegram](https://github.com/leshchenko1979/fast-mcp-telegram) also describes a multi-tenant gateway. The recommendation reflects architectural fit and fewer exact-name collisions.

GitHub checks used REST search/repositories with q=<candidate> in:name is:public fork:false. The selected candidate was also checked without excluding forks. Missing candidates returned zero results with incomplete_results=false. npm registry requests returned HTTP 200 for existing packages and 404 for missing ones. Examples: [tg-mcp metadata](https://registry.npmjs.org/tg-mcp), [telegram-mcp metadata](https://registry.npmjs.org/telegram-mcp), [telegram-user-mcp metadata](https://registry.npmjs.org/telegram-user-mcp).

Absence of a publication neither reserves a name nor guarantees registration. These observations concern public indexed projects and published npm packages on the research date. Recheck before creation/publication.

## Public title and Telegram terms

Telegram API Terms section 2.3 permits Telegram in application titles when preceded by Unofficial. Use **Unofficial Telegram MCP Gateway** for README titles, catalog listings, and title fields. Source: [Telegram API Terms](https://core.telegram.org/api/terms).

The terms state no separate exception for repository/npm identifiers. If one full name is needed everywhere or an identifier serves as an application title, unofficial-telegram-mcp-gateway retains the search properties. Broader Telegram-term applicability remains in the [publication plan](open-source-plan.md).

## Metadata accompanying the name

Suggested future public description, in English under decision 43:

> Unofficial Telegram MCP Gateway: read and search Telegram through your own accounts over MTProto. One local daemon, multiple accounts, access controls, and two-step write confirmation.

Explain access direction and actual capabilities immediately. Mention Claude Code, Codex, and OpenCode in compatibility text and setup instructions. README sections should answer practical channel-reading, message-search, and multi-account questions. Explain that the server cannot independently verify human consent.

Suggested GitHub topics: telegram, mcp, mcp-server, model-context-protocol, mtproto, multi-account. Decisions 36/37 select npm publication and the unscoped telegram-mcp-gateway name. npm description and keywords also influence search. Source: [npm package.json](https://docs.npmjs.com/cli/configuring-npm/package-json/).

The owner selected naming (35), npm publication (36), and package name (37). CLI/state/environment renaming, catalog registration, and repository creation are outside this research and require their relevant preparation decisions.
