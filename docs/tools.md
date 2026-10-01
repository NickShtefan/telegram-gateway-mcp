# Инструменты MCP

> Сгенерировано из данных интерактивной схемы (`docs/architecture.html`) 1 октября 2026. Дальше файл правится вручную.

Контракт, который видит агент. Наборы включаются переменной `TG_MCP_TOOLSETS` (по умолчанию `core`).

## Правила контракта

- Только tools; resources, prompts и elicitation необязательны и ни один сценарий на них не держится.
- Плоские JSON-схемы: строки, числа, boolean, enum и массивы из них. Без union, `anyOf` и вложенных объектов.
- Имена `tg_*` в snake_case. В `core` не больше 10-12 инструментов: описания всех инструментов попадают в контекст агента.
- Аннотации: `readOnlyHint` для чтения, `destructiveHint` для записи.
- Ответ компактным текстом (одна строка заголовка на сообщение: чат, автор, дата, просмотры, ответы, ссылка t.me), текст обрезан до лимита, в конце `next_cursor`. Для клиентов с outputSchema тот же ответ дублируется в `structuredContent`.
- Ошибки как `isError` с понятным текстом и `retry_after` для FLOOD_WAIT.
- Любой вызов укладывается примерно в 30 секунд, долгое оформляется задачей (`job_id`).
- Текст из Telegram всегда помечен как чужой (untrusted envelope).
- Вызов идёт от пользователя, которого шлюз узнаёт по bearer-токену. У инструментов, которые ходят в Telegram, необязательный параметр `account`: по умолчанию аккаунт пользователя, доступны только свои и общие аккаунты (решение 16).

## core: основной, включён по умолчанию

| Инструмент | Что делает | Методы MTProto | Откуда код | Компонент |
|---|---|---|---|---|
| `tg_status` | Кто вызывает и какие аккаунты доступны, лимиты, паузы FLOOD_WAIT, заморозка аккаунтов, включённые наборы | users.getUsers (self), help.getAppConfig | helper gramClient.ts:45 | Пул клиентов |
| `tg_resolve` | Карточка по @username, ссылке t.me или инвайту | contacts.resolveUsername, channels.getFullChannel, messages.checkChatInvite | telegramUtils.ts, universalSearchService.ts:264 | Резолвер |
| `tg_search_messages` | Поиск по всем чатам аккаунта; запрос с # ищет по публичным постам | messages.searchGlobal, channels.searchPosts | globalSearchService.ts | Поиск сообщений |
| `tg_search_chat` | Поиск внутри одного чата: слово, автор, даты, тема форума | messages.search | новое, пагинация из globalSearchService | Поиск сообщений |
| `tg_read_history` | Лента чата: курсор или окно дат, режим brief или full | messages.getHistory | forwardAnalysisService.ts:56, archiveService.ts:180 | Чтение |
| `tg_get_message` | Сообщение по ссылке плюс контекст до и после | channels.getMessages, messages.getHistory | refreshService.ts:75 | Чтение |
| `tg_get_comments` | Комментарии к посту, с поиском и сортировкой по реакциям | messages.getDiscussionMessage, messages.getReplies, messages.search | helper commentsRefresher.ts, discussion.ts | Комментарии |
| `tg_list_topics` | Темы форума в группе | getForumTopics | новое | Темы форумов |
| `tg_export` | Выгрузка по фильтрам в JSONL или CSV: цены, тип объявления, превью фото | messages.search, messages.getHistory, upload.getFile | db/export/export.ts, archiveService.ts:180 | Выгрузка в файл |
| `tg_get_media` | Фото, альбом целиком или превью видео; размер thumb или full; путь к файлу или картинка прямо в ответе | upload.getFile | processMediaClient.ts, archiveService.ts:345 | Изображения и медиа |

## automate: правила, поручения, входящие

| Инструмент | Что делает | Методы MTProto | Откуда код | Компонент |
|---|---|---|---|---|
| `tg_rule_set` | Создать или изменить правило мониторинга; только с подтверждением | - | новое | Правила |
| `tg_rules` | Список правил, лимиты и последние срабатывания | - | новое | Правила |
| `tg_watch` | Наблюдаемые чаты пользователя: добавить, убрать, список; любой канал, без подтверждения, события во входящие | messages.getHistory | новое, лестница опроса из helper ageTiers.ts | Наблюдатель |
| `tg_inbox` | Новые события с момента курсора | - | новое | Входящие |
| `tg_task_start` | Начать поручение: собеседник, цель, рамки, что решаешь ты, срок, первое сообщение, способ переписки (`via`: `account` или `business`); только с подтверждением | - | новое | Поручения |
| `tg_task_get` | Цель, рамки, состояние и переписка поручения; для запущенного агента | messages.getHistory | новое | Поручения |
| `tg_task_update` | Сменить состояние: ждём ответ, вопрос тебе, готово, закрыто; итог и отчёт | - | новое | Поручения |
| `tg_tasks` | Список поручений и их состояние, остановка поручения | - | новое | Поручения |

## write: запись, выключен по умолчанию, двухшаговое подтверждение

| Инструмент | Что делает | Методы MTProto | Откуда код | Компонент |
|---|---|---|---|---|
| `tg_reply` | Ответить в комментариях к посту, от своего имени или от имени канала | messages.getDiscussionMessage, messages.sendMessage | helper commentsRefresher.ts:311 + новое | Действия |
| `tg_join` | Вступить в канал или группу | channels.joinChannel, messages.importChatInvite | новое | Действия |
| `tg_react` | Поставить реакцию | messages.sendReaction | helper sendRandomReaction.ts:16 | Действия |
| `tg_send` | Написать человеку или в чат; внутри поручения только его собеседнику | messages.sendMessage | новое | Действия |

## discover: поиск каналов

| Инструмент | Что делает | Методы MTProto | Откуда код | Компонент |
|---|---|---|---|---|
| `tg_find_channels` | Каналы по теме: имя, рекомендации, хэштеги | contacts.search, channels.getChannelRecommendations | universalSearchService.ts:28 | Поиск каналов |
| `tg_similar_channels` | Похожие каналы, обход графа на 1-3 уровня | channels.getChannelRecommendations | recommendationsService.ts:97 | Поиск каналов |
| `tg_list_dialogs` | Чаты аккаунта и непрочитанное, через фильтр скоупов | messages.getDialogs | новое | Скоупы доступа |
| `tg_forward_sources` | Из каких каналов берутся репосты | messages.getHistory | forwardAnalysisService.ts:21 | Поиск каналов |

## index: локальный индекс

| Инструмент | Что делает | Методы MTProto | Откуда код | Компонент |
|---|---|---|---|---|
| `tg_index` | Добавить чат в локальный индекс, выгрузка задачей | messages.getHistory | archiveService.ts, viewsSyncService.ts | Локальный индекс |
| `tg_job_status` | Прогресс фоновой задачи | - | archiveService.ts:15 | Задачи |
| `tg_local_search` | Полнотекстовый поиск по индексу без запросов в Telegram | - | новое, SQLite FTS5 | SQLite |

## analytics: аналитика каналов из channel-scope

| Инструмент | Что делает | Методы MTProto | Откуда код | Компонент |
|---|---|---|---|---|
| `tg_channel_stats` | Скоринг, риск накрутки, ниша, цена рекламы | channels.getFullChannel + история | analyzeChannel.ts, botDetection.ts | Аналитика |

