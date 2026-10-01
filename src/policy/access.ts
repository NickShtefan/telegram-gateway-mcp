/**
 * Пользователи и доступ (решение 16). Bearer-токен определяет пользователя,
 * пользователь видит только свои и общие аккаунты.
 */
import { safeEqualHex, sha256Hex } from '../core/crypto.js';
import { GatewayError } from '../core/errors.js';
import type { Storage } from '../storage/port.js';

export interface Principal {
  userId: string;
  defaultAccount: string | null;
  /** Аккаунты, доступные пользователю. */
  accounts: string[];
}

export class AccessPolicy {
  constructor(private readonly storage: Storage) {}

  /** Пользователь по токену. Ошибка одинакова для «нет токена» и «неверный токен». */
  authenticate(token: string | null | undefined): Principal {
    const denied = (): never => {
      throw new GatewayError('ACCESS_DENIED', 'Missing or invalid gateway token.');
    };
    if (!token || token.length < 16) return denied();
    const hash = sha256Hex(token);
    const user = this.storage.users.findByTokenHash(hash);
    if (!user || !safeEqualHex(user.tokenSha256, hash)) return denied();
    return this.principalOf(user.id);
  }

  principalOf(userId: string): Principal {
    const user = this.storage.users.get(userId);
    if (!user) throw new GatewayError('ACCESS_DENIED', 'Unknown gateway user.');
    return {
      userId: user.id,
      defaultAccount: user.defaultAccount,
      accounts: this.storage.accounts.accountsOf(user.id).map(a => a.id),
    };
  }

  /**
   * Аккаунт для вызова: запрошенный или аккаунт по умолчанию. Чужой аккаунт
   * и несуществующий дают одну и ту же ошибку: о чужих аккаунтах агент не узнаёт.
   */
  resolveAccount(principal: Principal, requested?: string | null): string {
    const available = principal.accounts.length > 0 ? principal.accounts.join(', ') : 'none';
    if (requested) {
      if (!principal.accounts.includes(requested)) {
        throw new GatewayError('ACCESS_DENIED', `Account "${requested}" is not available to you. Your accounts: ${available}.`);
      }
      return requested;
    }
    if (principal.defaultAccount && principal.accounts.includes(principal.defaultAccount)) {
      return principal.defaultAccount;
    }
    if (principal.accounts.length === 1) return principal.accounts[0]!;
    throw new GatewayError(
      'INVALID_ARGUMENT',
      principal.accounts.length === 0
        ? 'No Telegram account is connected for you. The owner has to run tg-mcp login and tg-mcp account grant.'
        : `Specify the "account" argument. Your accounts: ${available}.`,
    );
  }

  /** Общий аккаунт: им пользуются несколько человек (решение 18). */
  isShared(accountId: string): boolean {
    return this.storage.accounts.usersOf(accountId).length > 1;
  }
}
