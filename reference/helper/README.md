# helper

Инструмент для управления Telegram-каналами: архивация постов и комментариев, автоматические реакции, статистика постов и реакций (включая реакции по акторам и реакции владельца канала).

## Что делает

- **Архивирует посты канала в реальном времени.** Bot API слушает новые / отредактированные посты и сохраняет в MongoDB (текст, entities, медиа, даты).
- **Собирает комментарии из группы обсуждений.** Bot API ловит новые комментарии, правки и реакции в реальном времени; фоновый воркер CommentsRefresher через GramJS переобходит треды — досылает пропущенное, сверяет реакции и детектит удаления (Bot API об удалениях не сообщает). Комментарии связываются с постами, хранятся авторы и метаданные медиа.
- **Запоминает, кто отреагировал на комментарий.** Каждый `message_reaction` сохраняет текущее состояние реакций конкретного актора; реакции владельца канала (личный аккаунт или «от имени канала») помечаются `isOwner` — видно, на какие комментарии владелец ответил реакцией, даже без текстового ответа.
- **Обновляет статистику постов.** Background worker через GramJS/MTProto периодически ходит в Telegram и освежает `stats.views` и `stats.reactions` — Bot API этих данных не отдаёт, только userbot-API может.
- **Ставит авто-реакцию** на каждый новый `channel_post`. Случайный эмодзи из сконфигурированного набора, через GramJS.
- **Скачивает медиа** — фото, видео, гиф, документы сохраняет на диск.
- **Импортирует историю канала** — одноразовая выгрузка всех старых постов.
- **Экспортирует в JSON** — посты вместе с комментариями, акторами реакций и `ownerReactions`, плюс копия медиа и мета о границах покрытия.

## Архитектура

```
┌─ Bot API listener (node-telegram-bot-api) ─┬─ новые / edited посты ─────► MongoDB posts
│                                            ├─ комментарии + реакции ────► MongoDB comments
│                                            │  (группа обсуждений)
│                                            └─ message_reaction (актор) ─► MongoDB commentReactionActors
│                                               (isOwner для владельца)
├─ GramJS singleton client (MTProto) ─── авто-реакция emoji ──────────────► posts
│        │
│        ├─ StatsRefresher ──── periodic channels.GetMessages ────────────► posts (views/reactions)
│        │                      └─ replies.replies разошёлся ──► будит CommentsRefresher
│        └─ CommentsRefresher ─ periodic GetDiscussionMessage/GetReplies ─► comments (сверка,
│                                                                           удаления, бэкфилл)
└─ оба воркера сериализуются через gramGate (один MTProto-вызов за раз)
```

## Быстрый старт

### 1. Установка

```bash
git clone git@github.com:NickShtefan/helper.git
cd helper
npm install
cp .env.example .env
```

### 2. Настройка `.env`

```env
# MongoDB
MONGO_USER=admin
MONGO_PASSWORD=your_password
MONGO_URI=mongodb://admin:your_password@127.0.0.1:27018/telegram_public?authSource=admin

# Bot API (listener + auto-reaction fallback)
TELEGRAM_TOKEN=your_bot_token
CHANNEL_USERNAME=your_channel      # username канала без @ (default: hardcode в src/config/telegram.ts)

# GramJS (userbot API, нужен для stats refresh и авто-реакций)
API_ID=your_api_id                # https://my.telegram.org
API_HASH=your_api_hash
PHONE_NUMBER=+1234567890           # для одноразового npm run session:generate
STRING_SESSION=                    # генерируется через npm run session:generate
GRAM_STARTUP_TIMEOUT_MS=120000     # опционально, default: 2 мин; дедлайн на старт GramJS-клиента (connect/getMe), десятичное целое 5000..2147483647

# Stats refresher (все опциональны)
STATS_REFRESH_TICK_MS=300000       # default: 5 мин
STATS_REFRESH_BATCH_SIZE=100       # default: 100 (MTProto лимит getMessages)
STATS_REFRESH_CUTOFF_DAYS=30       # default: 30 — после этого возраста посты перестают рефрешиться
STATS_REFRESH_GRAM_TIMEOUT_MS=30000 # default: 30 сек — дедлайн на каждый GramJS-вызов (resolvePeer / GetMessages)
STATS_REFRESH_FLOOD_WAIT_MAX_S=300 # default: 5 мин — FLOOD_WAIT больше капа не пережидаем, батч скипается
STATS_REFRESH_STUCK_TICKS_WARN=3   # default: 3 — после стольких подряд пропущенных tick'ов лог эскалируется в error

# Комментарии (все опциональны, полный список с дефолтами — в .env.example)
COMMENTS_ENABLED=true              # единый kill switch фичи комментариев
COMMENTS_DOWNLOAD_MEDIA=false      # качать файлы медиа комментариев (метаданные — всегда)
```

### 3. Сгенерируйте STRING_SESSION

```bash
npm run session:generate
```

Процесс интерактивный: скрипт отправит код подтверждения в Telegram-клиент, попросит ввести его, при необходимости 2FA. Выведет строку сессии — скопируйте в `.env` как `STRING_SESSION=...`.

> ⚠️ **Не шэрьте STRING_SESSION между окружениями** (dev и prod). Одна сессия на два устройства → Telegram инвалидирует обе (`AUTH_KEY_DUPLICATED`). Для каждой среды генерируйте отдельно.

### 4. Запуск

```bash
# Dev-режим: только MongoDB в Docker, бот с hot-reload на хосте
npm run dev

# Текущий production: бот + MongoDB локально в Docker
npm run docker:start

# Логи production-контейнера
npm run docker:logs

# Только MongoDB
npm run db:start
```

## Команды

```bash
npm start                  # запустить бот (listener + GramJS + StatsRefresher + CommentsRefresher)
npm run dev                # dev с hot-reload
npm test                   # юнит-тесты (vitest)
npm run build              # TS-компиляция в dist/
npm run session:generate   # одноразовый логин в Telegram, выдаёт STRING_SESSION
npm run history            # импорт истории канала (fetchHistorical.ts)
npm run comments:backfill  # ускоритель бэкфилла комментариев (ТОЛЬКО при остановленном сервисе!)
npm run export             # экспорт постов + комментариев + акторов в output/<channel>/
npm run db:start           # поднять только helper-mongo на 127.0.0.1:27018
npm run db:stop            # остановить только helper-mongo
npm run docker:start       # собрать и поднять helper-bot + helper-mongo
npm run docker:stop        # остановить весь локальный compose-проект helper
npm run docker:logs        # следить за логами helper-bot
```

## Импорт истории канала

Для импорта всех старых постов:

```bash
npm run history -- --channel=<username> --limit=<n>
```

- Использует GramJS (`client.iterMessages`) — забирает полные данные постов, включая views и reactions из Telegram-сервера.
- Поддерживает resume: при повторном запуске продолжает с последнего сохранённого `message_id`.
- Медиа скачиваются параллельно, сохраняются в `media/<channel>/<post-id>/`.

## Статистика (views + reactions)

Worker запускается автоматически при старте процесса. Каждые 5 минут (конфиг):

1. Находит посты с `nextRefreshAt ≤ сейчас`, где либо `date` в пределах cutoff (по умолчанию 30 дней), либо `stats.lastRefreshedAt` ещё не выставлен (**backfill** новых / впервые запущенного инстанса).
2. Группирует по каналу, запрашивает актуальные данные через `channels.GetMessages` (MTProto).
3. Обновляет `stats.views`, `stats.reactions`, `stats.lastRefreshedAt`, выставляет следующий `nextRefreshAt` по возрастной лестнице:
   - `< 1ч` → refresh каждые 15 мин
   - `< 6ч` → каждый час
   - `< 24ч` → каждые 3 часа
   - `< 7 дней` → 2 раза в сутки
   - `< 30 дней` → раз в 2 суток
   - `≥ 30 дней` → `null`, больше не трогается

Посты, удалённые на канале, и `CHANNEL_INVALID` помечаются `nextRefreshAt=null`, чтобы не опрашивать их бесконечно.

### Защита от залипания тика

Re-entrancy guard не даёт тикам накладываться: пока предыдущий не закончил, следующий отбивается. Из-за этого любой GramJS-вызов, повисший навсегда, убивал воркер целиком — тик не доходил до `finally`, флаг оставался поднятым, и все последующие тики писали `previous tick still running` до перезапуска процесса. Так рефрешер простоял с 3 по 12 августа 2026.

Что сделано (#82):

- **Дедлайн на каждый вызов.** `resolvePeer` и каждая попытка `channels.GetMessages`, включая retry после FLOOD_WAIT, обёрнуты в `STATS_REFRESH_GRAM_TIMEOUT_MS` (30 сек по умолчанию). В лог таймаута попадают стадия, канал, число постов, затраченное время и лимит. С #90 таймаут не пропускает канал: зависший GramJS-запрос нельзя безопасно отменить, поэтому процесс пишет `[GramRecovery]` и выходит с кодом 1, Docker пересоздаёт его.
- **Кап на FLOOD_WAIT.** Ожидание дольше `STATS_REFRESH_FLOOD_WAIT_MAX_S` (5 мин) не пережидается — батч пропускается, чтобы не занимать глобальный тик.
- **Watchdog.** Подряд идущие пропущенные тики считаются и логируются вместе с возрастом залипшего тика; после `STATS_REFRESH_STUCK_TICKS_WARN` (3) лог поднимается до `console.error`.

Диагностика: `docker logs helper-bot | grep -c "previous tick still running"` должен давать 0.

## Комментарии из группы обсуждений

Фича включена по умолчанию (`COMMENTS_ENABLED=true`). Дизайн: `docs/comments-collection-design.md`.

### Разовая настройка в Telegram

1. У канала должна быть привязана группа обсуждений (Настройки канала → Обсуждение).
2. Добавьте бота в группу и повысьте до **админа со всеми правами выключенными** — голого статуса достаточно (обходит privacy mode и открывает `message_reaction*`); права на удаление/бан/пост не нужны.
3. Если группа **приватная**: аккаунт юзербота (тот, что за `STRING_SESSION`) должен быть её участником — иначе `GetReplies` вернёт `CHANNEL_PRIVATE` и воркер запаркует посты при работающем realtime.
4. Перезапустите сервис и проверьте логи: `[Discussion] группа обсуждений: -100…`, `бот — administrator группы обсуждений`, первый `[CommentsRefresher] tick done`.

### Как это работает

- **Realtime (Bot API, секунды):** новые комментарии, правки и реакции. Корень-автофорвард (`is_automatic_forward`) связывает тред с постом; комментарии проходят позитивную проверку принадлежности к треду; всё пишется идемпотентными upsert'ами в коллекцию `comments`.
- **CommentsRefresher (GramJS, по расписанию):** переобходит треды (`GetDiscussionMessage` + `GetReplies`), досылает пропущенное за даунтайм, сверяет счётчики реакций и tombstone'ит удалённые комментарии (`deletedAt`, hard-delete не делается). Расписание — по эффективному возрасту (max даты поста и последнего комментария): от 10 мин для горячих тредов до раза в неделю, парковка после 30 дней. Все защиты StatsRefresher унаследованы: пер-вызовные таймауты, FLOOD_WAIT-кап (выше капа — прерывается весь тик), watchdog залипания.
- **Связка со статистикой:** счётчик комментариев (`replies.replies`) приходит в ответах StatsRefresher бесплатно; расхождение с кэшем немедленно будит переобход треда.
- Оба воркера делят один GramJS-клиент через `gramGate` — MTProto-вызовы строго по одному, таймаут внутри гейта (зависший вызов не блокирует второго воркера).

### Бэкфилл истории

Ничего запускать не нужно: стартовая миграция ставит все исторические посты в очередь, обычные тики дренируют её (~60 постов/час, несколько сотен постов — за ночь). Прогресс: `docker compose logs helper | grep 'tick done'`.

Скрипт-ускоритель — **только запасной выход** (второй процесс на том же `STRING_SESSION` → риск `AUTH_KEY_DUPLICATED`, обе сессии инвалидируются). Запуск строго при остановленном сервисе, через compose:

```bash
docker compose stop helper && docker compose run --rm helper node dist/telegram/client/backfillComments.js && docker compose up -d helper
```

Резюмируемый (пропускает уже пройденные посты), с lock-файлом `media/.backfill.lock` и wall-clock-капом (`COMMENTS_BACKFILL_MAX_RUNTIME_MIN`, 120 мин). Пока сервис остановлен, не пишутся и посты канала — держите остановку сильно короче 24 часов. Медиа при бэкфилле сохраняются только метаданными.

### Акторы реакций и реакции владельца

Каждый Bot API `message_reaction` дополнительно сохраняет **текущее состояние реакций конкретного актора** в коллекцию `commentReactionActors` (одна строка на «группа + комментарий + актор», replace-семантика; снятая реакция оставляет строку с `reactions: []`). Реакции владельца канала помечаются `isOwner: true`: личный аккаунт определяется как `me.id` юзербота (override — `CHANNEL_OWNER_USER_ID`), реакции «от имени канала» — по id канала. В экспорте у комментариев появляются `reactionActors[]` и `ownerReactions[]`.

**Граница покрытия (важно):** актор-данные собираются только из realtime-апдейтов **с момента деплоя фичи** (2026-08-13); анонимные реакции и агрегатные `message_reaction_count` актора не идентифицируют, GramJS-рефрешер чинит только счётчики. Поэтому актор-данные заведомо частичные — **источник истины по счётчикам всегда `Comment.reactions`**, и агрегаты никогда не выводятся из строк акторов. Исторический бэкфилл акторов (MTProto `GetMessageReactionsList`) сознательно не реализован — отдельная задача, если понадобится.

### Диагностика

```bash
docker compose logs helper | grep '\[CommentsRefresher\] tick done'   # heartbeat + пропускная способность
docker compose logs helper | grep 'worker looks stuck'                # watchdog обоих воркеров
docker compose logs helper | grep FLOOD_WAIT                          # флуд-давление
docker compose logs helper | grep 'comments unavailable\|root gone'   # запаркованные посты
docker compose logs helper | grep 'skipping tombstone'                # аномалии deletion-гарда (норма — пусто)
docker compose logs helper | grep '\[gramGate\]'                      # контеншн полосы MTProto
```

### Откат

`git checkout <old-sha> && npm run docker:start`. Сбор комментариев останавливается (старый `allowed_updates` перестаёт доставлять группу — ожидаемо и обратимо); после ролл-форварда пропуск добирается воркером через расписание и связку `replies.replies`. Ролл-форвард желателен в пределах дней. Формат ключей реакций постов фича не меняла — откат безопасен для `stats.reactions`.

### Dev-безопасность (двойной запуск)

Два поллера на одном бот-токене делят апдейты и ловят 409; второй GramJS-клиент на одном `STRING_SESSION` убивает обе сессии. Для локальной разработки используйте **второго бота** (BotFather, админ тестовой группы) и **отдельную** `STRING_SESSION` — никогда не копируйте прод-`.env` на dev-машину как есть.

## Авто-реакция

На каждый новый `channel_post` ставится случайный эмодзи из `config.telegram.reactionEmojis` (`src/config/telegram.ts`). Идемпотентность: edited-пост не получает повторную реакцию, если `ownReaction` уже выставлен.

## Экспорт

```bash
npm run export
```

Выгружает в `output/<channel>/` (канал сейчас фиксирован в `src/db/export/export.ts`):

- `formattedPosts.json` — все посты со статистикой и вложенными комментариями: у каждого комментария `author`, агрегированные `reactions`, `reactionActors[]` (кто отреагировал, с флагом `isOwner`), `ownerReactions[]`, `commentsCount`, tombstone-поля (`deletedAt`);
- `orphanComments.json` — комментарии, не привязанные к посту (если есть);
- `orphanReactionActors.json` — актор-строки без комментария, например реакции на корни-автофорварды (если есть);
- `exportMeta.json` — мета о границах покрытия актор-данных (partial, самая ранняя запись, matched/orphan счётчики);
- копии медиафайлов (посты — все скачанные, комментарии — только скачанные при `COMMENTS_DOWNLOAD_MEDIA=true`).

## Структура проекта

```
src/
├── index.ts                              # Точка входа: mongo + gramClient + listener + оба воркера
├── config/telegram.ts                    # Конфигурация (канал, эмодзи, флаги комментариев)
├── scripts/generateSession.ts            # Одноразовый генератор STRING_SESSION
├── db/
│   ├── models/Post.ts                    # Mongoose-модель поста (stats, discussion, nextRefreshAt)
│   ├── models/Comment.ts                 # Mongoose-модель комментария (identity, linkage, tombstone)
│   ├── models/CommentReactionActor.ts    # Текущее состояние реакций актора на комментарий (+isOwner)
│   └── export/export.ts                  # Экспорт из БД в JSON (посты + комментарии + акторы)
└── telegram/
    ├── discussion.ts                     # Единый резолв группы обсуждений (Bot API + GramJS)
    ├── bot/
    │   └── listenerBot.ts                # Bot API — посты, комментарии, реакции (позитивный роутинг)
    ├── client/
    │   ├── gramClient.ts                 # GramJS singleton (MTProto)
    │   ├── gramGate.ts                   # Сериализация MTProto-вызовов двух воркеров
    │   ├── fetchHistorical.ts            # GramJS — импорт истории одной командой
    │   └── backfillComments.ts           # Скрипт-ускоритель бэкфилла комментариев (escape hatch)
    ├── processors/
    │   ├── processPost.ts                # Обработка и сохранение поста из Bot API
    │   ├── processComment.ts             # Комментарии: корни-автофорварды, гард треда, upsert
    │   ├── processReactions.ts           # Реакции постов (message_reaction_count канала)
    │   ├── processCommentReactions.ts    # Реакции комментариев: дифф-фолд + снапшот
    │   ├── reactionKey.ts                # Единый ключ реакции (Bot API + GramJS формы)
    │   ├── processMediaBot.ts            # Скачивание медиа через Bot API (посты + комментарии)
    │   ├── processMediaClient.ts         # Скачивание медиа через GramJS (при history-fetch)
    │   └── sendRandomReaction.ts         # Авто-реакция emoji на пост
    ├── utils/
    │   ├── chatId.ts                     # -100…/MTProto конвертация id (в базе только Bot API-форма)
    │   └── env.ts                        # envNumber / envBool
    └── workers/
        ├── ageTiers.ts                   # Расписание refresh статистики по возрасту
        ├── commentsAgeTiers.ts           # Расписание обходов тредов (эффективный возраст)
        ├── refreshShared.ts              # Общий каркас воркеров: таймауты, FLOOD_WAIT, реакции
        ├── statsRefresher.ts             # Background worker обновления stats
        └── commentsRefresher.ts          # Background worker сверки комментариев
```

## Стек

- **Node.js 22** (ESM, TypeScript) — образ собирается на `node:22-alpine`
- **node-telegram-bot-api** — Bot API polling
- **telegram (GramJS)** — MTProto для session, stats refresh, auto-reactions, history import, сверки комментариев
- **Mongoose + MongoDB** (Docker)
- **vitest** — юнит-тесты

## Текущий production

С 30 июля 2026 helper переехал с VPS/systemd на локальный Docker в этом workspace.

- Compose project: `helper`.
- Бот: `helper-bot`.
- MongoDB: `helper-mongo`.
- Host endpoint MongoDB: `127.0.0.1:27018`.
- Внутри compose-сети бот подключается к `mongodb:27017/telegram_public`.
- Оба контейнера используют `restart: unless-stopped`.
- Если GramJS-клиент не поднялся за `GRAM_STARTUP_TIMEOUT_MS` (по умолчанию 2 мин, отсчёт после подключения к MongoDB; например нет сети), бот пишет `[GramRecovery] fatal MTProto timeout: GramClient startup (connect/getMe) timed out after …` и выходит с кодом 1, Docker пересоздаёт процесс (#91). Второй клиент внутри процесса не создаётся. 2 мин, а не меньше: `getMe` внутри себя пережидает FLOOD_WAIT до 60 сек. Допустимы только десятичные цифры, 5000..2147483647 мс; любое другое значение (дробное, hex, `1e5`, `+5000`, пустое, вне диапазона) даёт warn `[GramClient] GRAM_STARTUP_TIMEOUT_MS=… is not a plain decimal integer in [5000, 2147483647]` и дефолт.

Запуск и проверка:

```bash
npm run docker:start
docker ps --filter name=helper
npm run docker:logs
```

GitHub Actions теперь только проверяет build/tests. Старый SSH-деплой на VPS отключён.

## Лицензия

Private project, не для публичного распространения.
