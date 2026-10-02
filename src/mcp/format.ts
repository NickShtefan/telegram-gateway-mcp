/**
 * Форматтер ответов. Компактный текст вместо JSON: одна строка заголовка на
 * сообщение (id, дата, автор, счётчики, ссылка) и текст в границах чужого
 * контента. `JSON.stringify(results, null, 2)` из channel-scope не повторяем:
 * он съедает контекст агента.
 */
import type { ReactionCount } from '../core/reactions.js';
import { safeLabel, type Envelope } from '../policy/envelope.js';
import type { ButtonDto } from '../services/buttons.js';
import type { AuthorDto, MediaDto, MessageDto } from '../services/messages.js';

export type FormatMode = 'brief' | 'full';

export interface FormatOptions {
  mode: FormatMode;
  envelope: Envelope;
  /** Предел длины текста одного сообщения в полном режиме. */
  maxTextChars?: number;
  /** Предел длины строки текста в кратком режиме. */
  briefChars?: number;
  /** Ссылка t.me на сообщение, если её можно построить. */
  linkFor?: (message: MessageDto) => string | null;
  /** Показывать ли автора: в ленте канала он у всех постов один. */
  showAuthor?: boolean;
  /** Подпись чата для выдачи из нескольких чатов (глобальный поиск). */
  chatLabel?: (message: MessageDto) => string | null;
}

export const DEFAULT_MAX_TEXT_CHARS = 1500;
export const DEFAULT_BRIEF_CHARS = 220;

/** 1234 -> 1.2k, 1200000 -> 1.2M. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.trunc(n));
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const value = n / size;
      const text = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
      return text + suffix;
    }
  }
  return String(n);
}

/** Дата в UTC без секунд: `2026-09-30 14:05`. */
export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown date';
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function authorLabel(author: AuthorDto): string {
  if (author.username) return `@${safeLabel(author.username, 40)}`;
  const name = safeLabel(author.name, 40);
  if (name) return author.kind === 'user' && author.peerKey ? `${name} (id ${author.peerKey})` : name;
  if (author.kind === 'anonymous') return 'anonymous';
  return author.peerKey ? `id ${author.peerKey}` : 'unknown';
}

/**
 * Подпись автора. `own`: сообщение отправлено с самого аккаунта (флаг out).
 * Помечается словами «this account», а не «you»: с аккаунта пишет и владелец руками.
 */
export function formatAuthor(author: AuthorDto, own = false): string {
  const label = authorLabel(author);
  if (!own || author.kind !== 'user') return label;
  return label === 'unknown' ? 'this account' : `${label} (this account)`;
}

export function formatReactions(reactions: ReactionCount[], top = 3): string {
  if (reactions.length === 0) return '';
  const shown = reactions.slice(0, top).map(r => `${r.reaction.startsWith('custom:') ? '⭐' : r.reaction === 'paid' ? '★paid' : r.reaction}${compactNumber(r.count)}`);
  const rest = reactions.slice(top).reduce((sum, r) => sum + r.count, 0);
  return shown.join(' ') + (rest > 0 ? ` +${compactNumber(rest)}` : '');
}

export function formatMediaTag(media: MediaDto | null, grouped: boolean): string {
  if (!media) return '';
  switch (media.kind) {
    case 'photo':
      return grouped ? '[album photo]' : '[photo]';
    case 'video':
      return `[${grouped ? 'album ' : ''}video${media.durationSec ? ' ' + formatDuration(media.durationSec) : ''}]`;
    case 'gif':
      return '[gif]';
    case 'voice':
      return `[voice${media.durationSec ? ' ' + formatDuration(media.durationSec) : ''}]`;
    case 'audio':
      return `[audio${media.durationSec ? ' ' + formatDuration(media.durationSec) : ''}]`;
    case 'sticker':
      return '[sticker]';
    case 'document':
      return `[file${media.fileName ? ' ' + safeLabel(media.fileName, 40) : ''}]`;
    case 'webpage':
      return media.url ? `[link ${safeLabel(media.url, 80)}]` : '[link]';
    case 'poll':
      return '[poll]';
    case 'geo':
      return '[location]';
    case 'contact':
      return '[contact]';
    default:
      return '[media]';
  }
}

/** Подписи видов кнопок для агента. Нажимается только callback (tg_press_button). */
const BUTTON_KIND: Record<ButtonDto['kind'], string> = {
  callback: 'callback',
  url: 'link',
  login: 'login link',
  webapp: 'web app',
  switch_inline: 'inline query',
  game: 'game',
  buy: 'payment',
  profile: 'profile',
  copy: 'copy text',
  disabled: 'disabled',
  other: 'other',
};

function buttonCount(m: MessageDto): number {
  return m.buttons.reduce((sum, row) => sum + row.length, 0);
}

/**
 * Inline-кнопки сообщения одной строкой: место (ряд.позиция), подпись и вид.
 * Байтов callback и адресов ссылок здесь нет.
 */
export function formatButtons(m: MessageDto): string {
  const items: string[] = [];
  m.buttons.forEach((row, r) => {
    row.forEach((button, p) => {
      const kind = BUTTON_KIND[button.kind] + (button.needsPassword ? ', asks for the 2FA password' : '');
      items.push(`${r + 1}.${p + 1} "${safeLabel(button.text, 48).replace(/"/g, "'")}" (${kind})`);
    });
  });
  return items.length > 0 ? `buttons: ${items.join(' | ')}` : '';
}

/** Строка заголовка сообщения: всё, кроме текста. */
export function formatHeader(m: MessageDto, options: FormatOptions): string {
  const parts: string[] = [`#${m.id}`, formatDate(m.date)];
  const chat = options.chatLabel?.(m);
  if (chat) parts.push(`in ${chat}`);
  if (options.showAuthor !== false) parts.push(formatAuthor(m.author, m.out));
  if (m.topicId !== null) parts.push(`topic ${m.topicId}`);
  if (m.replyToId !== null && m.replyToId !== m.topicId) parts.push(`re #${m.replyToId}`);
  if (m.forwardedFrom) parts.push(`fwd from ${safeLabel(m.forwardedFrom.name, 40) || 'unknown'}`);
  if (m.views !== null) parts.push(`views ${compactNumber(m.views)}`);
  if (m.forwards !== null && m.forwards > 0) parts.push(`shares ${compactNumber(m.forwards)}`);
  if (m.replies !== null && (m.replies > 0 || m.hasComments)) {
    parts.push(`${m.hasComments ? 'comments' : 'replies'} ${compactNumber(m.replies)}`);
  }
  const reactions = formatReactions(m.reactions);
  if (reactions) parts.push(reactions);
  const media = formatMediaTag(m.media, m.groupedId !== null);
  if (media) parts.push(media);
  // В кратком режиме кнопки только считаются: сами они видны в полном режиме и в tg_get_message.
  if (options.mode === 'brief' && buttonCount(m) > 0) parts.push(`buttons ${buttonCount(m)}`);
  if (m.pinned) parts.push('pinned');
  if (m.editDate !== null) parts.push('edited');
  if (m.service) parts.push(`service: ${m.service.replace(/^MessageAction/, '')}`);
  const link = options.linkFor?.(m);
  if (link) parts.push(link);
  return parts.join(' | ');
}

export function formatMessage(m: MessageDto, options: FormatOptions): string {
  const header = formatHeader(m, options);
  if (options.mode === 'brief') {
    return m.text ? `${header}\n${options.envelope.inline(m.text, options.briefChars ?? DEFAULT_BRIEF_CHARS)}` : header;
  }
  const buttons = formatButtons(m);
  const tail = buttons ? `\n${buttons}` : '';
  if (!m.text) return header + tail;
  const max = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const cut = m.text.length > max ? `\n(text cut at ${max} of ${m.text.length} chars; read it in full with tg_get_message)` : '';
  return `${header}\n${options.envelope.block(m.text, max)}${cut}${tail}`;
}

export interface ListOptions extends FormatOptions {
  /** Первая строка ответа: что это за выборка. */
  title: string;
  /** Курсор следующей страницы; null, если страниц больше нет. */
  nextCursor?: string | null;
  /** Строки после списка: подсказки агенту. */
  hints?: string[];
}

export function formatMessageList(messages: MessageDto[], options: ListOptions): string {
  const lines: string[] = [options.title];
  if (messages.length === 0) {
    lines.push('No messages.');
  } else {
    lines.push(options.envelope.notice(), 'Times are UTC.', '');
    const sep = options.mode === 'brief' ? '\n' : '\n\n';
    lines.push(messages.map(m => formatMessage(m, options)).join(sep));
  }
  const tail: string[] = [...(options.hints ?? [])];
  if (options.nextCursor) tail.push(`next_cursor: ${options.nextCursor}`);
  else if (messages.length > 0) tail.push('End of results.');
  if (tail.length > 0) lines.push('', ...tail);
  return lines.join('\n');
}

/** Пары «ключ: значение» одной карточкой, для tg_resolve. */
export function formatCard(title: string, rows: Array<[string, string | number | null | undefined]>): string {
  const lines = [title];
  for (const [key, value] of rows) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}
