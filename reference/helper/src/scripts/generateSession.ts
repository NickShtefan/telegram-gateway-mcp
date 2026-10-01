import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

/**
 * Одноразовый интерактивный логин в Telegram через userbot API.
 * Печатает сгенерированную STRING_SESSION в stdout — скопируйте её в .env.
 *
 * Запуск: npm run session:generate
 */
async function main(): Promise<void> {
  const apiIdRaw = process.env.API_ID;
  const apiHash = process.env.API_HASH;
  const phoneNumber = process.env.PHONE_NUMBER;

  if (!apiIdRaw || !apiHash) {
    console.error('API_ID / API_HASH are missing in env. Get them at https://my.telegram.org');
    process.exit(1);
  }
  if (!phoneNumber) {
    console.error('PHONE_NUMBER is missing in env (format: +1234567890)');
    process.exit(1);
  }

  const apiId = parseInt(apiIdRaw, 10);
  const stringSession = new StringSession('');

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log('Starting interactive login. You will be asked for confirmation code...');
  await client.start({
    phoneNumber,
    password: async () => await input.text('Enter 2FA password (leave empty if none): '),
    phoneCode: async () => await input.text('Enter confirmation code: '),
    onError: (err: Error) => console.error(err),
  });

  const session = client.session.save() as unknown as string;

  console.log('\n=== STRING_SESSION generated ===\n');
  console.log(session);
  console.log('\nCopy the line above into your .env as STRING_SESSION=...\n');

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Session generation failed:', err);
  process.exit(1);
});
