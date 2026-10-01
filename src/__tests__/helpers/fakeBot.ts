/**
 * Двойник Bot API: запоминает отправленные карточки и правки, а обновления
 * (нажатия кнопок, сообщения) тест подаёт сам через `Approvals.handleUpdate`.
 */
import { BotApiError, type BotApi, type BotUpdate, type BotUser, type InlineButton, type SendOptions } from '../../automation/botApi.js';

export interface SentCard {
  chatId: string;
  messageId: number;
  text: string;
  buttons: InlineButton[][];
  options: SendOptions;
}

export class FakeBot implements BotApi {
  readonly sent: SentCard[] = [];
  readonly edits: Array<{ chatId: string; messageId: number; text: string }> = [];
  readonly answers: Array<{ id: string; text?: string }> = [];
  /** Код ошибки, с которым упадёт следующая отправка. */
  failNextSend: number | null = null;
  private nextMessageId = 100;
  private nextUpdateId = 1;

  async getMe(): Promise<BotUser> {
    return { id: 999, username: 'approval_bot' };
  }

  async getUpdates(): Promise<BotUpdate[]> {
    return [];
  }

  async sendMessage(chatId: string | number, text: string, options: SendOptions = {}): Promise<{ message_id: number }> {
    if (this.failNextSend !== null) {
      const code = this.failNextSend;
      this.failNextSend = null;
      throw new BotApiError('sendMessage', code, code === 403 ? "Forbidden: bot can't initiate conversation with a user" : 'Bad Request');
    }
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId: String(chatId), messageId, text, buttons: options.buttons ?? [], options });
    return { message_id: messageId };
  }

  async editMessageText(chatId: string | number, messageId: number, text: string): Promise<void> {
    this.edits.push({ chatId: String(chatId), messageId, text });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text });
  }

  /** Последняя карточка согласования. */
  lastCard(): SentCard {
    const cards = this.sent.filter(s => s.buttons.length > 0);
    if (cards.length === 0) throw new Error('no approval card was sent');
    return cards[cards.length - 1]!;
  }

  /** Обновление «человек нажал кнопку». */
  press(card: SentCard, label: string, fromId: string | number): BotUpdate {
    const button = card.buttons.flat().find(b => b.text.includes(label));
    if (!button) throw new Error(`no button "${label}" on the card: ${card.buttons.flat().map(b => b.text).join(', ')}`);
    return {
      update_id: this.nextUpdateId++,
      callback_query: {
        id: `cb${this.nextUpdateId}`,
        from: { id: Number(fromId) },
        message: { message_id: card.messageId, chat: { id: Number(card.chatId), type: 'private' } },
        data: button.data,
      },
    };
  }

  /** Обновление «человек написал боту». */
  text(fromId: string | number, text: string): BotUpdate {
    return {
      update_id: this.nextUpdateId++,
      message: { message_id: this.nextMessageId++, date: 0, chat: { id: Number(fromId), type: 'private' }, from: { id: Number(fromId) }, text },
    };
  }
}
