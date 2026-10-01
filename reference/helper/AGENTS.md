# AGENTS.md — Helper production boundaries

This repository runs Nick's Telegram helper and the `@stonksnws` content database.

## Production topology

- Production is local Docker from this repository.
- Compose project: `helper`.
- Bot container: `helper-bot`.
- MongoDB container: `helper-mongo`.
- MongoDB host endpoint: `127.0.0.1:27018`; database: `telegram_public`.
- Persistent database path: `data/db/`. Never delete, replace, reset, or reinitialize it without Nick's explicit approval and a verified backup.
- The former VPS container `canary-mongo` is legacy. Do not point content workflows, scripts, or documentation back to it.
- GitHub Actions is verification only (`npm test` + `npm run build`). Production deployment is a deliberate local rebuild with `npm run docker:start`.

## High-risk runtime constraints

- Never run a second Bot API poller with the production `TELEGRAM_TOKEN`. Two pollers split updates and cause conflicts/data gaps.
- Never run a second GramJS client with the production `STRING_SESSION`. Concurrent reuse can trigger `AUTH_KEY_DUPLICATED` and invalidate the session.
- `npm run comments:backfill` is an escape hatch, not a routine command. Run it only when the main `helper` service is stopped, following the README procedure.
- Do not run historical imports, backfills, database migrations, container rebuilds, or production restarts during an audit unless Nick explicitly asked for that action.
- Never print `.env`, Telegram tokens, MongoDB credentials, `STRING_SESSION`, API hashes, or connection URIs containing secrets.

## Data sources and semantics

Database `telegram_public` contains:

- `posts` — channel posts, views, aggregate reactions, and discussion metadata.
- `comments` — comments linked to posts with author, thread, media metadata, aggregate reactions, edits, and deletion tombstones.
- `commentreactionactors` — current per-actor reaction state captured from realtime `message_reaction` updates.

Rules:

- `comments.reactions` is authoritative for aggregate reaction totals.
- `commentreactionactors` is partial by design: collection began on 2026-08-13, anonymous/count-only reactions have no identity, and historical actor identities were not backfilled.
- Never derive total reactions from actor rows.
- Treat `reactions: []` in an actor row as a recorded removal/current empty state, not as a row to silently discard.
- Resolve comments to posts via `postTelegramId`; resolve reply parents within `discussionChatId`, never by global `messageId` alone.
- Preserve tombstones (`deletedAt`); do not hard-delete archived comments by default.

## Change discipline

- Before changing code, inspect `git status`, current branch, and relevant open PRs/issues.
- Keep changes narrowly scoped. Do not stage or commit unrelated files.
- Any collector/schema change must include tests for idempotency, replay, and partial-data behavior.
- Run `npm run build` and `npm test` before reporting code changes complete.
- A successful build is not proof of production collection. Verify container startup logs and read back MongoDB state after deployment.
- Do not commit or push unless Nick explicitly requested the implementation or repository update in the current conversation.

## Operational references

- Runtime/setup/backfill/rollback: `README.md`.
- Comment collector architecture and data model: `docs/comments-collection-design.md`.
- Compose topology: `docker-compose.yml`.
- Environment options without secrets: `.env.example`.
