/**
 * `tg-mcp login --account <имя>`: вход в аккаунт Telegram и сохранение
 * зашифрованной сессии. Код и пароль 2FA вводит хозяин аккаунта.
 */
import { loginAccount } from '../core/auth.js';
import { defaultClientFactory, type ClientFactory } from '../core/clientPool.js';
import { loadSessionSecret, requireApiCredentials, type GatewayConfig } from '../core/config.js';
import { seal } from '../core/crypto.js';
import { isLockHeld } from '../core/lock.js';
import { createLogger } from '../core/log.js';
import type { Storage } from '../storage/port.js';
import { assertId } from './admin.js';
import type { CliIo } from './io.js';

export interface LoginCommandOptions {
  config: GatewayConfig;
  storage: Storage;
  io: CliIo;
  account: string;
  phone?: string;
  factory?: ClientFactory;
  sessionSecret?: string;
}

export async function runLogin(options: LoginCommandOptions): Promise<void> {
  const { config, storage, io } = options;
  const accountId = assertId('account', options.account);
  const { apiId, apiHash } = requireApiCredentials(config);
  const secret = options.sessionSecret ?? loadSessionSecret(config.home);

  const hadSession = storage.sessions.get(accountId) !== null;
  const daemonRunning = await isLockHeld(config.home);

  const phone = options.phone ?? (await io.prompt('Phone number (international format, e.g. +79991234567): '));

  io.err('Telegram will send a login code to this account (in the Telegram app or by SMS).');
  const result = await loginAccount({
    factory: options.factory ?? defaultClientFactory,
    apiId,
    apiHash,
    phone,
    prompts: {
      code: () => io.prompt('Login code: ', { hidden: true }),
      password: hint => io.prompt(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `, { hidden: true }),
    },
    log: createLogger('login'),
  });

  storage.transaction(() => {
    storage.accounts.upsert({ id: accountId, ...result.identity, status: 'active' });
    storage.sessions.put(accountId, seal(result.session, secret));
  });

  const name = result.identity.username ? `@${result.identity.username}` : (result.identity.displayName ?? 'no username');
  io.out(`Account "${accountId}" is logged in as ${name} (Telegram id ${result.identity.tgUserId}).`);

  const users = storage.accounts.usersOf(accountId);
  if (users.length === 0) {
    io.out(`No gateway user can use it yet. Grant access: tg-mcp account grant ${accountId} <user>`);
  } else {
    io.out(`Gateway users with access: ${users.join(', ')}.`);
  }
  if (daemonRunning && hadSession) {
    io.out('The daemon is running with the previous session of this account. Restart it to switch to the new one.');
  }
}
