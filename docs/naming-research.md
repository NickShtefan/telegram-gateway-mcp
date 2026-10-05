# Название для органического поиска

Проверено 6 октября 2026 по времени Кипра. Владелец принял рекомендацию в тот же день, см. решение 35 в [decisions.md](decisions.md).

Выбранный идентификатор репозитория: **`telegram-mcp-gateway`**. Публичный заголовок приложения: **Unofficial Telegram MCP Gateway**. Полные слова `Telegram` и `MCP` обозначают категорию, а `gateway` описывает архитектуру: один демон предоставляет агентам доступ к аккаунтам через MCP. Поиск точного названия даёт меньше столкновений, чем `tg-mcp` и `telegram-mcp`; соседство `telegram-mcp` имеет проверяемое преимущество в официальном MCP Registry.

Это вывод об обнаружимости и понятности названия. Частотность запросов, будущий трафик и позиции в Google не измерены. Название само по себе не обеспечивает рекомендации агентами.

## Как человек может искать инструмент

Для проверки использованы технические и прикладные формулировки. Это примеры намерений, а не рейтинг популярности запросов.

| Намерение | Примеры запроса | Что должно быть понятно из карточки проекта |
|---|---|---|
| Уже знает MCP | `telegram mcp server`, `MCP сервер Telegram читать сообщения` | Telegram, MCP server, чтение и поиск |
| Хочет подключить своего агента | `read Telegram messages with Claude MCP`, `connect Telegram to Codex MCP` | Агент получает инструменты доступа к Telegram |
| Ищет особенность | `Telegram MCP multi account` | Несколько аккаунтов, один демон, права доступа |
| Ищет конкретный проект | `telegram-mcp-gateway` | Однозначное название и ссылка на репозиторий |

Выдача по общим словам смешивает разные направления интеграции. [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) предоставляет доступ к Telegram через MCP, а [patriceac/codex-telegram](https://github.com/patriceac/codex-telegram) управляет Codex из Telegram. Поэтому в описании нашего проекта нужно явно сказать: агент читает и ищет данные через подключённые аккаунты Telegram. Слово `bridge` само по себе это направление не объясняет.

В GitHub обычный поиск репозиториев учитывает название, описание и topics; поиск по README включается отдельно через `in:readme`. Нужные слова должны присутствовать в метаданных карточки, а не только глубоко в документации. Источник: [GitHub Docs](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories).

Google рекомендует понятные, краткие заголовки и избегать набивки ключевыми словами. Это поддерживает описательное название, но не доказывает, что порядок `telegram-mcp-gateway` повысит позиции относительно `telegram-gateway-mcp`. Источник: [Google Search Central](https://developers.google.com/search/docs/appearance/title-link).

## Как инструмент может найти агент

Здесь важен конкретный способ поиска: веб-поиск, GitHub, официальный MCP Registry или отдельный каталог. Их поведение различается.

В официальном MCP Registry параметр `search` ищет **подстроку в имени сервера без учёта регистра**. Это не семантический поиск по описанию. Следующая таблица относится к буквальному запросу в этом API, при условии регистрации сервера с таким именем. Источник: [документация API MCP Registry](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md).

| Часть имени сервера | `search=telegram` | `search=telegram-mcp` |
|---|---|---|
| `tg-mcp` | нет | нет |
| `telegram-gateway-mcp` | да | нет |
| `telegram-mcp-gateway` | да | да |
| `unofficial-telegram-mcp-gateway` | да | да |

Живая проверка API с `version=latest&limit=100`: запрос `telegram-mcp` вернул четыре записи, а `tg-mcp` семь. Все семь имён во второй выборке относятся к другим сочетаниям: `prtg-mcp`, `mtg-mcp`, `btg-mcp` и их вариантам. Это конкретный пример шума от сокращения, а не измерение спроса на Telegram. Обе выборки получены целиком, без следующей страницы.

Для публикации через GitHub официальный Registry требует пространство имён `io.github.<username>/...`. Возможный идентификатор: `io.github.NickShtefan/telegram-mcp-gateway`. Отдельные поля `title`, `description`, `repository` и сведения об установке помогают клиенту понять и подключить найденный сервер. Регистрация остаётся будущим действием. Источники: [quickstart Registry](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx), [формат server.json](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md).

Для агентного веб-поиска нет проверенного универсального правила ранжирования. Google отдельно сообщает, что для его AI Overviews и AI Mode действуют обычные основы SEO и не нужны специальные файлы или дополнительная разметка для ИИ. Это правило относится к Google, а не ко всем агентам. Источник: [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features).

## Сравнение вариантов

| Вариант | Проверенные столкновения | Оценка для нашего проекта |
|---|---|---|
| `tg-mcp` | npm-пакет уже опубликован другим автором | Коротко, но сокращение скрывает Telegram; высокий риск перепутать установку |
| `telegram-mcp` | Одноимённые GitHub-проекты и npm-пакет уже есть | Ясная категория, слабая различимость конкретного проекта |
| `telegram-gateway-mcp` | Публичный GitHub-проект и npm-пакет в проверке не найдены | Понятно, но отсутствует буквальная подстрока `telegram-mcp` |
| **`telegram-mcp-gateway`** | Публичный GitHub-проект и npm-пакет в проверке не найдены | Лучший баланс понятности, различимости и поиска в Registry |
| `telegram-mcp-bridge` | Одноимённые GitHub-проекты есть; npm-пакет не найден | Поиск смешивает инструменты чтения Telegram с управлением агентом из Telegram |
| `telegram-user-mcp` | GitHub-проекты и npm-пакет уже есть | Уточняет тип аккаунта, но имя занято и слово `user` неоднозначно |
| `unofficial-telegram-mcp-gateway` | Публичный GitHub-проект и npm-пакет в проверке не найдены | Более длинный вариант, сохраняющий обе подстроки и слово Unofficial в самом идентификаторе |

`gateway` не является уникальным преимуществом: [fast-mcp-telegram](https://github.com/leshchenko1979/fast-mcp-telegram) тоже описывает себя как шлюз с несколькими арендаторами. Рекомендация основана на совпадении слова с нашей архитектурой и меньшем числе столкновений точного сочетания.

Проверка GitHub выполнена через REST API: `search/repositories` с `q=<вариант> in:name is:public fork:false`; для `telegram-mcp-gateway` дополнительно проверен поиск без исключения forks. У всех перечисленных отсутствующих вариантов было ноль результатов, `incomplete_results=false`. Проверка npm выполнена чтением `https://registry.npmjs.org/<имя>`: существующие пакеты вернули HTTP 200, отсутствующие HTTP 404. Например, [данные tg-mcp](https://registry.npmjs.org/tg-mcp), [данные telegram-mcp](https://registry.npmjs.org/telegram-mcp), [данные telegram-user-mcp](https://registry.npmjs.org/telegram-user-mcp).

Отсутствие публикации не резервирует имя и не гарантирует возможность его регистрации. Проверка относится к публичным индексируемым проектам и опубликованным npm-пакетам на указанную дату. Перед созданием репозитория или пакета её нужно повторить.

## Публичное имя и правила Telegram

Пункт 2.3 Telegram API Terms говорит, что заголовок приложения может включать `Telegram`, если перед ним стоит `Unofficial`. Поэтому для README, карточек каталогов и поля `title` предлагается **Unofficial Telegram MCP Gateway**. Источник: [Telegram API Terms](https://core.telegram.org/api/terms).

Документ не устанавливает отдельного исключения для имени репозитория или npm-пакета. Если требуется одинаковое полное имя во всех местах либо технический идентификатор используется как заголовок приложения, вариант `unofficial-telegram-mcp-gateway` сохраняет поисковые свойства. Это вопрос оформления названия; остальные вопросы применимости условий Telegram остаются в [плане открытия](open-source-plan.md).

## Что должно сопровождать название

Предложение для будущей публичной карточки, после решения о языке материалов:

> Unofficial Telegram MCP Gateway: read and search Telegram through your own accounts over MTProto. One local daemon, multiple accounts, access controls, and two-step write confirmation.

Первая строка должна объяснять направление доступа и реальные возможности. Упоминания Claude Code, Codex и OpenCode лучше поместить в короткое описание совместимости и инструкции подключения. В README полезны отдельные разделы с ответами на прикладные вопросы: как читать каналы, искать сообщения и подключить несколько аккаунтов. Подтверждение записи нужно описывать с существующей границей: сервер не удостоверяет согласие человека.

Предлагаемые GitHub topics: `telegram`, `mcp`, `mcp-server`, `model-context-protocol`, `mtproto`, `multi-account`. npm-публикация выбрана в решении 36, имя пакета `telegram-mcp-gateway` без scope в решении 37. `description` и `keywords` пакета тоже участвуют в поиске npm. Источник: [npm package.json](https://docs.npmjs.com/cli/configuring-npm/package-json/).

Семейство названия выбрано владельцем в решении 35, npm-публикация первого выпуска в решении 36, имя пакета в решении 37. Изменения команд `tg-mcp`, папки состояния, переменных среды, регистрация в каталогах и создание нового репозитория в это исследование не входят и требуют соответствующих следующих решений.
