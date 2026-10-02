/**
 * Пул клиентов teleproto: одно подключение на аккаунт, параллельные попытки
 * подключиться склеиваются, connect ограничен по времени, подключение без
 * интерактива и с проверкой `getMe`.
 *
 * Второй клиент на той же сессии не создаётся никогда: AUTH_KEY_DUPLICATED.
 */
import { TelegramClient } from 'teleproto';
import { Logger as GramLogger } from 'teleproto/extensions';
import { LogLevel as GramLogLevel } from 'teleproto/extensions/Logger';
import { StringSession } from 'teleproto/sessions';
import { unseal } from './crypto.js';
import { classifyError, GatewayError } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { DeadlineError, withTimeout } from './time.js';
import type { Storage } from '../storage/port.js';

export interface ClientParams {
  session: string;
  apiId: number;
  apiHash: string;
  log: Logger;
}

export type ClientFactory = (params: ClientParams) => TelegramClient;

/** Логгер teleproto, который пишет в stderr через логгер шлюза. */
class StderrGramLogger extends GramLogger {
  constructor(private readonly sink: Logger) {
    super(GramLogLevel.WARN);
  }

  // Базовый логгер пишет через console.log, то есть в stdout: этот метод заменяет его целиком.
  override log(level: GramLogLevel, message: string, error?: unknown): void {
    const text = error === undefined ? message : `${message}: ${error instanceof Error ? error.message : String(error)}`;
    if (level === GramLogLevel.ERROR) this.sink.error(text);
    else if (level === GramLogLevel.WARN) this.sink.warn(text);
    else this.sink.debug(text);
  }
}

export const defaultClientFactory: ClientFactory = ({ session, apiId, apiHash, log }) =>
  new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    // FLOOD_WAIT шлюз разбирает сам (лимитер): teleproto не должен спать молча.
    floodSleepThreshold: 0,
    baseLogger: new StderrGramLogger(log),
  });

export interface AccountIdentity {
  tgUserId: string;
  username: string | null;
  displayName: string | null;
}

export interface PoolCredentials {
  apiId: number;
  apiHash: string;
  /** Секрет для расшифровки сессий. */
  sessionSecret: string;
}

export interface ClientPoolOptions {
  storage: Storage;
  /**
   * Учётные данные запрашиваются при первом подключении, а не при создании
   * пула: команды, которым Telegram не нужен, работают и без них.
   */
  credentials: () => PoolCredentials;
  factory?: ClientFactory;
  connectTimeoutMs?: number;
  /** Подключение зависло: процесс должен выйти. */
  onFatal: (reason: string) => void;
  log?: Logger;
}

interface MeLike {
  id?: unknown;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export class ClientPool {
  private readonly clients = new Map<string, TelegramClient>();
  private readonly pending = new Map<string, Promise<TelegramClient>>();
  private readonly identities = new Map<string, AccountIdentity>();
  private readonly factory: ClientFactory;
  private readonly connectTimeoutMs: number;
  private readonly log: Logger;

  constructor(private readonly options: ClientPoolOptions) {
    this.factory = options.factory ?? defaultClientFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.log = options.log ?? createLogger('pool');
  }

  async getClient(accountId: string): Promise<TelegramClient> {
    const existing = this.clients.get(accountId);
    if (existing) return existing;

    const pending = this.pending.get(accountId);
    if (pending) return pending;

    const connecting = this.connect(accountId);
    this.pending.set(accountId, connecting);
    try {
      return await connecting;
    } finally {
      this.pending.delete(accountId);
    }
  }

  /** Кто подключён под этим аккаунтом; известно после первого подключения. */
  identity(accountId: string): AccountIdentity | null {
    return this.identities.get(accountId) ?? null;
  }

  /** Сессия перестала работать: клиент закрывается, аккаунт помечается. */
  async markUnauthorized(accountId: string): Promise<void> {
    this.options.storage.accounts.setStatus(accountId, 'unauthorized');
    await this.drop(accountId);
  }

  async drop(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    this.clients.delete(accountId);
    this.identities.delete(accountId);
    if (client) await this.destroy(client);
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map(id => this.drop(id)));
  }

  private async connect(accountId: string): Promise<TelegramClient> {
    const { storage } = this.options;
    const account = storage.accounts.get(accountId);
    if (!account) {
      throw new GatewayError('NOT_FOUND', `Account "${accountId}" is not configured in the gateway.`);
    }
    const sealed = storage.sessions.get(accountId);
    if (!sealed) {
      throw new GatewayError(
        'ACCOUNT_UNAUTHORIZED',
        `Account "${accountId}" has no Telegram session. The owner has to run: tg-mcp login --account ${accountId}`,
      );
    }

    const credentials = this.options.credentials();

    let session: string;
    try {
      session = unseal(sealed, credentials.sessionSecret);
    } catch {
      throw new GatewayError(
        'ACCOUNT_UNAUTHORIZED',
        `The stored session of account "${accountId}" cannot be decrypted (wrong session key). The owner has to log in again.`,
      );
    }

    const client = this.factory({
      session,
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      log: this.log.child(`mtproto:${accountId}`),
    });

    let me: MeLike | null;
    try {
      // connect и getMe под общим дедлайном: без сети оба могут не завершиться никогда.
      me = await withTimeout(
        (async () => {
          await client.connect();
          return (await client.getMe()) as MeLike | null;
        })(),
        this.connectTimeoutMs,
        `connect account ${accountId}`,
      );
    } catch (err) {
      await this.destroy(client);
      if (err instanceof DeadlineError) {
        this.options.onFatal(err.message);
        throw new GatewayError('UNAVAILABLE', `Could not connect account "${accountId}" to Telegram in time.`, { cause: err });
      }
      const classified = classifyError(err);
      if (classified.code === 'ACCOUNT_UNAUTHORIZED') {
        storage.accounts.setStatus(accountId, 'unauthorized');
      }
      throw classified;
    }

    if (!me || me.id === undefined || me.id === null) {
      await this.destroy(client);
      storage.accounts.setStatus(accountId, 'unauthorized');
      throw new GatewayError(
        'ACCOUNT_UNAUTHORIZED',
        `The Telegram session of account "${accountId}" is not authorized. The owner has to run: tg-mcp login --account ${accountId}`,
      );
    }

    const identity: AccountIdentity = {
      tgUserId: String(me.id),
      username: me.username ?? null,
      displayName: [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || null,
    };
    this.identities.set(accountId, identity);
    storage.accounts.upsert({ id: accountId, ...identity, status: 'active' });
    this.clients.set(accountId, client);
    this.log.info('account connected', { account: accountId, username: identity.username });
    return client;
  }

  /** destroy, а не disconnect: иначе в teleproto остаётся цикл обновлений-зомби. */
  private async destroy(client: TelegramClient): Promise<void> {
    try {
      await withTimeout(client.destroy(), 5_000, 'client.destroy');
    } catch {
      // закрытие не должно ронять вызывающего
    }
  }
}
