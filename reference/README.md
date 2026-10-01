# reference

Снимок исходников соседних репозиториев, которые tg-mcp переиспользует. Только для чтения: правки вносятся в новый код tg-mcp, а не сюда.

- Какие файлы копируются: [MANIFEST.txt](MANIFEST.txt).
- С каких веток и коммитов снят снимок: [SNAPSHOT.md](SNAPSHOT.md).
- Обновить снимок: `scripts/sync-reference.sh` (исходные репозитории только читает).
- Что в какой компонент идёт: [../docs/borrow-map.md](../docs/borrow-map.md).

Структура путей повторяет расположение в `~/Projects/CODE/Chanel/`: например, `reference/helper/src/telegram/client/gramGate.ts` это копия `helper/src/telegram/client/gramGate.ts`.
