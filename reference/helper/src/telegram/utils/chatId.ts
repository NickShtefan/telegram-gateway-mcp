/**
 * Конвертация id супергруппы/канала между двумя формами:
 * MTProto (GramJS) отдаёт «голый» положительный channel_id (иногда BigInteger),
 * Bot API — отрицательный с префиксом -100 (например -1001782171896).
 * В базе всё хранится ТОЛЬКО в Bot API-форме (docs/comments-collection-design.md §4.1) —
 * все GramJS-писатели обязаны нормализовать id через toBotApiChatId.
 */
const BOT_API_CHANNEL_OFFSET = 1_000_000_000_000;

export function toBotApiChatId(mtprotoChannelId: number | bigint | string): number {
  const id = Number(mtprotoChannelId);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    throw new Error(
      `toBotApiChatId: ожидается положительный MTProto channel_id, получено: ${String(mtprotoChannelId)}`
    );
  }
  return -(BOT_API_CHANNEL_OFFSET + id);
}

export function toMtprotoChannelId(botApiChatId: number): number {
  if (!Number.isFinite(botApiChatId) || !Number.isInteger(botApiChatId) || botApiChatId >= -BOT_API_CHANNEL_OFFSET) {
    throw new Error(
      `toMtprotoChannelId: ожидается Bot API chat id в форме -100…, получено: ${String(botApiChatId)}`
    );
  }
  return -botApiChatId - BOT_API_CHANNEL_OFFSET;
}

/** Проверка, что значение похоже на Bot API id супергруппы/канала (-100…). */
export function isBotApiChannelId(value: number): boolean {
  return Number.isInteger(value) && value < -BOT_API_CHANNEL_OFFSET;
}
