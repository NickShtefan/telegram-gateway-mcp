# ChannelScope

## Overview
Telegram channel research & analytics tool. Multi-account Telegram client management, channel discovery, post archiving, media download, quality analytics, and a React-based web UI for managing the entire workflow.

## Architecture
- `src/telegram/client/` — GramJS client for historical import (fetchHistorical.ts)
- `src/telegram/processors/` — Post, media, reaction processors
- `src/web/` — Express server (port 3001), SSE progress, REST API, ClientManager (multi-account)
- `src/web/archiveService.ts` — Archive/download service using ClientManager sessions
- `src/db/models/` — Mongoose models (Post, Channel, ResearchChannel, Client, Admin)
- `src/services/` — Business logic (TGStat, analyzeChannel, etc.)
- `web/` — React 18 + Vite + Tailwind SPA (dev on :5173, proxied to :3001)

## Commands
- Build: `npm run build`
- Test: `npm run test`
- Start: `npm start`
- Web server: `npm run web`
- Dev (API + React hot-reload): `npm run dev:all`
- Web dev only: `npm run web:dev`
- Build frontend: `npm run web:build`
- Historical import: `npm run history`

## Tech Stack
- TypeScript, Node.js, GramJS
- MongoDB (Mongoose), Express, Vitest
- Deploy: systemd on VPS (deployer@45.76.93.76), GitHub Actions auto-deploy

## Conventions
- All code in TypeScript
- Tests in `__tests__/` directories next to source
- Mock external deps (mongoose, TelegramClient, fs)
- Follow existing test patterns

## Constraints
- GramJS requires interactive auth (SMS code) — only for historical import
- Rate limit: pause 5s every 20 messages when iterating
- MongoDB on VPS: `telegram_public` database

## Current State
- Repo: `NickShtefan/channel-scope`
- Tests: Vitest (3 files)
- Known issues: views never update after initial save

## Review Checklist
- [ ] `npx vitest run` passes
- [ ] `npm run build` succeeds (tsc)
- [ ] No hardcoded secrets
- [ ] Follows existing code patterns
