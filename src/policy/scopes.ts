/**
 * Скоупы доступа: что агенту можно читать и куда писать.
 *
 * По умолчанию открыты каналы и группы (публичные и те, где аккаунт состоит).
 * Личные переписки закрыты и открываются только правилом `allow`: владельцем
 * или поручением, которое открывает ровно один диалог. Служебные чаты Telegram
 * закрыты всегда: туда приходят коды входа.
 */
import type { PeerKind } from '../core/chatId.js';
import { GatewayError } from '../core/errors.js';
import type { Storage } from '../storage/port.js';

/** Telegram (коды входа), BotFather, SpamBot, служебные уведомления. */
export const SERVICE_PEER_KEYS: ReadonlySet<string> = new Set(['777000', '93372553', '178220800', '42777']);
export const SERVICE_USERNAMES: ReadonlySet<string> = new Set(['botfather', 'spambot', 'telegram', 'notoscam']);

export interface ScopeTarget {
  peerKey: string;
  kind: PeerKind;
  username?: string | null;
}

export type ScopeDecision = { allowed: true } | { allowed: false; reason: string };

export class ScopePolicy {
  constructor(private readonly storage: Storage) {}

  decide(userId: string, accountId: string, target: ScopeTarget): ScopeDecision {
    const username = target.username ? target.username.replace(/^@/, '').toLowerCase() : null;

    if (SERVICE_PEER_KEYS.has(target.peerKey) || (username !== null && SERVICE_USERNAMES.has(username))) {
      return { allowed: false, reason: 'Telegram service chats (login codes, BotFather, SpamBot) are never available through the gateway.' };
    }

    const rules = this.storage.scopes.list(userId, accountId).filter(r => r.target === target.peerKey || (username !== null && r.target === username));
    if (rules.some(r => r.effect === 'deny')) {
      return { allowed: false, reason: 'This chat is on the deny list set by the owner.' };
    }
    if (rules.some(r => r.effect === 'allow')) return { allowed: true };

    if (target.kind === 'user') {
      return {
        allowed: false,
        reason:
          'Private chats are closed by default. The owner can open one with: tg-mcp scope allow <user> <account> <chat>, or start a task for this person.',
      };
    }
    return { allowed: true };
  }

  /** Бросает ACCESS_DENIED, если чат закрыт. */
  assertAllowed(userId: string, accountId: string, target: ScopeTarget): void {
    const decision = this.decide(userId, accountId, target);
    if (!decision.allowed) throw new GatewayError('ACCESS_DENIED', decision.reason);
  }

  isAllowed(userId: string, accountId: string, target: ScopeTarget): boolean {
    return this.decide(userId, accountId, target).allowed;
  }
}
