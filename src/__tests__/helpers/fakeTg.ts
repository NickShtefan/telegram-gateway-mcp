/**
 * Двойник шлюза Telegram для тестов сервисов и инструментов. Отвечает на
 * запросы по `className`, запоминает вызовы и, как настоящий TgGateway,
 * складывает сущности из ответов в кэш аккаунта.
 */
import type { Api, TelegramClient } from 'telegram';
import type { AccountIdentity } from '../../core/clientPool.js';
import { harvestEntities } from '../../core/entities.js';
import type { LaneStatus } from '../../core/limiter.js';
import type { Tg, TgCallOptions } from '../../core/tg.js';
import type { EntitiesRepo } from '../../storage/port.js';

export interface RecordedCall {
  accountId: string;
  className: string;
  // Поля запроса разные у каждого метода: в тестах читаются как есть.
  request: any;
  options?: TgCallOptions;
}

type Handler = (request: any, accountId: string) => unknown;

export class FakeTg implements Tg {
  readonly calls: RecordedCall[] = [];
  private readonly handlers = new Map<string, Handler>();
  client: Partial<TelegramClient> = {};

  constructor(private readonly entities?: EntitiesRepo) {}

  /** Ответ на метод, например `messages.GetHistory`. */
  on(className: string, handler: Handler): this {
    this.handlers.set(className, handler);
    return this;
  }

  callsOf(className: string): RecordedCall[] {
    return this.calls.filter(c => c.className === className);
  }

  last(className: string): RecordedCall {
    const found = this.callsOf(className);
    if (found.length === 0) throw new Error(`no ${className} call recorded`);
    return found[found.length - 1]!;
  }

  async invoke<R extends Api.AnyRequest>(accountId: string, request: R, options?: TgCallOptions): Promise<R['__response']> {
    const className = (request as { className?: string }).className ?? 'unknown';
    this.calls.push({ accountId, className, request, options });
    const handler = this.handlers.get(className);
    if (!handler) throw new Error(`FakeTg: unexpected call ${className}`);
    const result = await handler(request, accountId);
    if (this.entities) {
      const found = harvestEntities(result);
      if (found.length > 0) this.entities.putMany(found.map(e => ({ accountId, ...e })));
    }
    return result as R['__response'];
  }

  async withClient<T>(accountId: string, label: string, fn: (client: TelegramClient) => Promise<T>, options?: TgCallOptions): Promise<T> {
    this.calls.push({ accountId, className: `client:${label}`, request: null, options });
    return fn(this.client as TelegramClient);
  }

  async whoami(accountId: string): Promise<AccountIdentity> {
    return { tgUserId: '1001', username: `${accountId}_acc`, displayName: 'Test Account' };
  }

  laneStatus(): LaneStatus {
    return { queued: 0, running: false, callsInWindow: this.calls.length, perMinute: 60, lastCallAt: null, floodWaitSeconds: 0, pausedMethods: [] };
  }
}

/** Канал, как его отдаёт Telegram. */
export function rawChannel(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { className: 'Channel', id: BigInt(id), accessHash: BigInt(id * 7 + 1), title: `Channel ${id}`, broadcast: true, ...extra };
}

export function rawUser(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { className: 'User', id: BigInt(id), accessHash: BigInt(id * 3 + 1), firstName: `User${id}`, ...extra };
}

/** Сообщение в канале или супергруппе. */
export function rawMessage(channelId: number, id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    className: 'Message',
    id,
    peerId: { className: 'PeerChannel', channelId: BigInt(channelId) },
    date: 1_790_000_000 + id * 60,
    message: `message ${id}`,
    ...extra,
  };
}
