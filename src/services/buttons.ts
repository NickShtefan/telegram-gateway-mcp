/**
 * Inline-кнопки под сообщением (решение 31). Агент видит вид кнопки, её подпись,
 * место в клавиатуре (ряд и позиция) и адрес, если кнопка ведёт по ссылке. Байты
 * callback в выдачу не попадают: нажатие шлюз собирает сам из свежего сообщения.
 *
 * В слое 229 клавиатура это `ReplyInlineMarkup` с рядами `KeyboardInlineButtonRow`;
 * вид кнопки лежит в её поле `type` (`InlineButtonTypeCallback` и другие).
 */
import { createHash } from 'node:crypto';

export type ButtonKind = 'callback' | 'url' | 'login' | 'webapp' | 'switch_inline' | 'game' | 'buy' | 'profile' | 'copy' | 'disabled' | 'other';

export interface ButtonDto {
  kind: ButtonKind;
  /** Подпись кнопки: чужой текст. */
  text: string;
  /** Кнопка callback, которая просит пароль 2FA аккаунта. */
  needsPassword: boolean;
  /** Адрес у кнопок, которые ведут по ссылке: ссылка, вход на сайт, веб-приложение. Чужой текст. */
  url: string | null;
}

const KINDS: Record<string, ButtonKind> = {
  InlineButtonTypeCallback: 'callback',
  InlineButtonTypeUrl: 'url',
  InlineButtonTypeUrlAuth: 'login',
  InputInlineButtonTypeUrlAuth: 'login',
  InlineButtonTypeWebView: 'webapp',
  InlineButtonTypeSwitchInline: 'switch_inline',
  InlineButtonTypeGame: 'game',
  InlineButtonTypeBuy: 'buy',
  InlineButtonTypeUserProfile: 'profile',
  InputInlineButtonTypeUserProfile: 'profile',
  InlineButtonTypeCopy: 'copy',
  InlineButtonTypeDisabled: 'disabled',
};

interface RawButton {
  text?: unknown;
  type?: { className?: string; data?: unknown; requiresPassword?: boolean; url?: unknown } | null;
}

interface RawMarkup {
  className?: string;
  rows?: Array<{ buttons?: Array<RawButton | null> } | null>;
}

function inlineRows(replyMarkup: unknown): RawButton[][] {
  const markup = replyMarkup as RawMarkup | null;
  if (!markup || typeof markup !== 'object' || markup.className !== 'ReplyInlineMarkup' || !Array.isArray(markup.rows)) return [];
  // Ряды и позиции не пересчитываются: по ним же кнопка ищется при нажатии.
  return markup.rows.map(row => (Array.isArray(row?.buttons) ? row.buttons.map(b => b ?? {}) : []));
}

function toDto(button: RawButton): ButtonDto {
  return {
    kind: KINDS[button.type?.className ?? ''] ?? 'other',
    text: typeof button.text === 'string' ? button.text : '',
    needsPassword: button.type?.requiresPassword === true,
    url: typeof button.type?.url === 'string' && button.type.url !== '' ? button.type.url : null,
  };
}

/** Inline-клавиатура сообщения рядами; пустой список, если её нет. */
export function normalizeButtons(replyMarkup: unknown): ButtonDto[][] {
  return inlineRows(replyMarkup).map(row => row.map(toDto));
}

export interface LocatedButton extends ButtonDto {
  /** Байты callback; есть только у кнопки вида callback. */
  data: Buffer | null;
  /** Отпечаток кнопки: по нему видно, что между предпросмотром и нажатием она не сменилась. */
  fingerprint: string;
}

/** Кнопка сырого сообщения по ряду и позиции (с единицы); null, если такой нет. */
export function buttonAt(rawMessage: unknown, row: number, position: number): LocatedButton | null {
  const raw = inlineRows((rawMessage as { replyMarkup?: unknown } | null)?.replyMarkup)[row - 1]?.[position - 1];
  if (!raw) return null;
  const dto = toDto(raw);
  const bytes = raw.type?.data;
  const data = dto.kind === 'callback' && bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
  const fingerprint = createHash('sha256')
    .update(`${dto.kind}\n${dto.text}\n`)
    .update(data ?? Buffer.alloc(0))
    .digest('hex');
  return { ...dto, data, fingerprint };
}
