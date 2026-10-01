import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';

let client: TelegramClient | null = null;
let selfUserId: number | null = null;
const peerCache = new Map<string, Api.TypeInputPeer>();

/**
 * Инициализирует GramJS-клиент как singleton для main-процесса.
 * Использует STRING_SESSION из .env — без интерактивного логина.
 * Сгенерировать сессию можно через `npm run session:generate`.
 */
export async function initGramClient(): Promise<void> {
  if (client) {
    console.warn('[GramClient] Already initialised');
    return;
  }

  const apiIdRaw = process.env.API_ID;
  const apiHash = process.env.API_HASH;
  const sessionString = process.env.STRING_SESSION;

  if (!apiIdRaw || !apiHash) {
    throw new Error('[GramClient] API_ID / API_HASH are missing in env');
  }
  if (!sessionString) {
    throw new Error(
      '[GramClient] STRING_SESSION is empty. Generate it via `npm run session:generate` and put into .env'
    );
  }

  const apiId = parseInt(apiIdRaw, 10);
  if (Number.isNaN(apiId)) {
    throw new Error('[GramClient] API_ID must be a number');
  }

  const stringSession = new StringSession(sessionString);
  const c = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  // .connect() в отличие от .start() не требует интерактива;
  // если сессия невалидна — будет ошибка авторизации при первом invoke.
  await c.connect();
  const me = await c.getMe().catch(() => null);
  if (!me) {
    throw new Error(
      '[GramClient] Failed to authorise with STRING_SESSION. Regenerate it via `npm run session:generate`.'
    );
  }

  client = c;
  // id аккаунта юзербота — дефолтная идентичность владельца канала для
  // определения его реакций на комментарии (override: CHANNEL_OWNER_USER_ID).
  selfUserId = me.id !== undefined && me.id !== null ? Number(me.id) : null;
  console.info('[GramClient] connected as', 'username' in me ? me.username : me.id?.toString());
}

/** user id аккаунта за STRING_SESSION; null до initGramClient(). */
export function getSelfUserId(): number | null {
  return selfUserId;
}

export function getGramClient(): TelegramClient {
  if (!client) {
    throw new Error('[GramClient] Not initialised. Call initGramClient() first.');
  }
  return client;
}

/**
 * Резолвит InputPeer для канала по username с кэшированием.
 */
export async function resolvePeer(channelUsername: string): Promise<Api.TypeInputPeer> {
  const cached = peerCache.get(channelUsername);
  if (cached) return cached;

  const c = getGramClient();
  const entity = await c.getInputEntity(channelUsername);
  peerCache.set(channelUsername, entity);
  return entity;
}
