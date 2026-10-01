/**
 * Вход в аккаунт Telegram: телефон, код, пароль 2FA. Вызывается только из
 * `tg-mcp login`, не из инструментов: агент не видит код подтверждения.
 *
 * Порядок перенесён из channel-scope `clientManager.startAuth`: клиент всегда
 * новый, с пустой сессией, телефон передаётся строкой, а `connect()` перед
 * `start()` не вызывается, чтобы GramJS сам провёл миграцию между дата-центрами.
 */
import type { ClientFactory, AccountIdentity } from './clientPool.js';
import { classifyError, GatewayError } from './errors.js';
import type { Logger } from './log.js';
import { withTimeout } from './time.js';

export interface LoginPrompts {
  code(): Promise<string>;
  /** Пароль двухфакторной защиты; hint это подсказка, заданная владельцем. */
  password(hint?: string): Promise<string>;
}

export interface LoginOptions {
  factory: ClientFactory;
  apiId: number;
  apiHash: string;
  phone: string;
  prompts: LoginPrompts;
  log: Logger;
  /** Сколько человек может думать над кодом или паролем. */
  inputTimeoutMs?: number;
  /** Сколько неверных кодов или паролей допустимо, прежде чем прервать вход. */
  maxAttempts?: number;
}

export interface LoginResult {
  /** Строка сессии. Её нельзя логировать: шифруется и уходит в хранилище. */
  session: string;
  identity: AccountIdentity;
}

interface MeLike {
  id?: unknown;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  const phone = digits.startsWith('+') ? digits : `+${digits}`;
  if (!/^\+\d{7,15}$/.test(phone)) {
    throw new GatewayError('INVALID_ARGUMENT', 'Phone number must be in international format, for example +79991234567.');
  }
  return phone;
}

export async function loginAccount(options: LoginOptions): Promise<LoginResult> {
  const inputTimeoutMs = options.inputTimeoutMs ?? 5 * 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const phone = normalizePhone(options.phone);
  const client = options.factory({ session: '', apiId: options.apiId, apiHash: options.apiHash, log: options.log });

  let errors = 0;
  let lastError: Error | null = null;
  // Человек прервал ввод (Ctrl-C, таймаут): GramJS проглатывает такую ошибку и спрашивает заново.
  let aborted: Error | null = null;
  const ask = async (label: string, prompt: () => Promise<string>): Promise<string> => {
    try {
      return await withTimeout(prompt(), inputTimeoutMs, label);
    } catch (err) {
      aborted = err instanceof GatewayError ? err : new GatewayError('UNAVAILABLE', `Login cancelled: ${(err as Error).message}`);
      throw aborted;
    }
  };

  try {
    await client.start({
      phoneNumber: phone,
      phoneCode: () => ask('phone code input', () => options.prompts.code()),
      password: (hint?: string) => ask('2FA password input', () => options.prompts.password(hint)),
      // Без этого GramJS для незарегистрированного номера молча создаёт новый аккаунт и принимает условия Telegram.
      firstAndLastNames: async () => {
        aborted = new GatewayError('INVALID_ARGUMENT', 'This phone number has no Telegram account. The gateway does not register new accounts.');
        throw aborted;
      },
      onError: async (err: Error) => {
        errors++;
        lastError = aborted ?? err;
        options.log.warn('login step failed', { error: lastError.message, attempt: errors });
        // true останавливает вход: иначе GramJS спрашивает код заново без конца.
        return aborted !== null || errors >= maxAttempts;
      },
    });

    const me = (await client.getMe()) as MeLike | null;
    if (!me || me.id === undefined || me.id === null) {
      throw lastError ?? new GatewayError('ACCOUNT_UNAUTHORIZED', 'Login did not complete: Telegram did not authorize the session.');
    }

    const session = String(client.session.save() ?? '');
    if (!session) {
      throw new GatewayError('ACCOUNT_UNAUTHORIZED', 'Login completed, but the session is empty.');
    }

    return {
      session,
      identity: {
        tgUserId: String(me.id),
        username: me.username ?? null,
        displayName: [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || null,
      },
    };
  } catch (err) {
    throw classifyError(aborted ?? lastError ?? err);
  } finally {
    // Клиент входа закрывается всегда: демон откроет своего с той же сессией.
    try {
      await withTimeout(client.destroy(), 5_000, 'client.destroy');
    } catch {
      // не мешаем вернуть результат или исходную ошибку
    }
  }
}
