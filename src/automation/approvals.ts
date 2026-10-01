/**
 * Согласование записи. Любое действие, которое что-то меняет в Telegram,
 * сначала приходит человеку в бота: «Отправить», «Изменить», «Пропустить».
 * Выполняет действие шлюз, а не агент, и только после нажатия кнопки.
 *
 * Почему не `confirm_token`, как было в решении 4: токен, который вернулся
 * агенту, агент может подтвердить сам (так устроен tg-mcp-guarded, см.
 * prior-art.md). Подтверждение должно идти мимо модели.
 *
 * Кнопки принимаются только от того человека, чьё это действие: сверяется
 * `from.id`, а не чат (образец: официальный Telegram-плагин Claude Code).
 */
import { randomBytes } from 'node:crypto';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import { sleep } from '../core/time.js';
import { sanitizeText, truncate } from '../policy/envelope.js';
import type { Storage } from '../storage/port.js';
import { BotApiError, type BotApi, type BotCallbackQuery, type BotMessage, type BotUpdate, type InlineButton } from './botApi.js';
import type { ApprovalRecord, AutomationStore } from './store.js';

export interface ApprovalRequest {
  userId: string;
  accountId: string | null;
  kind: string;
  /** tool, rule:<id> или task:<id>. */
  source: string;
  /** Аргументы действия. Поле `text` это черновик, который человек может заменить. */
  payload: Record<string, unknown>;
  /** Что и где будет сделано: пишет шлюз, чужого текста здесь нет. */
  title: string;
  ttlMs?: number;
}

/** Исполнитель действия после одобрения. Возвращает то, что увидят человек и агент. */
export type ApprovalExecutor = (approval: ApprovalRecord) => Promise<{ summary: string; data?: Record<string, unknown> }>;

interface ExecutorEntry {
  run: ApprovalExecutor;
  /** Можно ли заменить текст черновика. */
  editable: boolean;
  /** Подписи кнопок. */
  approveLabel: string;
  rejectLabel: string;
}

export interface ApprovalsOptions {
  store: AutomationStore;
  storage: Storage;
  /** null: бот не настроен, запись недоступна. */
  bot: BotApi | null;
  log?: Logger;
  now?: () => number;
  defaultTtlMs?: number;
}

const DRAFT_MAX_CHARS = 3000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export class Approvals {
  private readonly store: AutomationStore;
  private readonly storage: Storage;
  private readonly bot: BotApi | null;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly executors = new Map<string, ExecutorEntry>();
  private readonly updateHandlers: Array<(update: BotUpdate) => Promise<boolean>> = [];

  constructor(options: ApprovalsOptions) {
    this.store = options.store;
    this.storage = options.storage;
    this.bot = options.bot;
    this.log = options.log ?? createLogger('approvals');
    this.now = options.now ?? (() => Date.now());
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  get enabled(): boolean {
    return this.bot !== null;
  }

  /** Клиент Bot API для тех, кто пишет человеку через того же бота (вопросы и отчёты поручений). */
  get botApi(): BotApi | null {
    return this.bot;
  }

  /**
   * Дополнительный обработчик обновлений бота: вопросы поручений и
   * Business-сообщения. Вернувший true забирает обновление себе.
   */
  addUpdateHandler(handler: (update: BotUpdate) => Promise<boolean>): void {
    this.updateHandlers.push(handler);
  }

  register(kind: string, run: ApprovalExecutor, options: { editable?: boolean; approveLabel?: string; rejectLabel?: string } = {}): void {
    this.executors.set(kind, {
      run,
      editable: options.editable ?? false,
      approveLabel: options.approveLabel ?? '✅ Отправить',
      rejectLabel: options.rejectLabel ?? '🚫 Пропустить',
    });
  }

  /** Создаёт согласование и отправляет карточку человеку в бота. */
  async request(request: ApprovalRequest): Promise<ApprovalRecord> {
    const entry = this.executors.get(request.kind);
    if (!entry) throw new GatewayError('INVALID_ARGUMENT', `Unknown action kind "${request.kind}".`);
    if (!this.bot) {
      throw new GatewayError(
        'UNAVAILABLE',
        'Write actions are not available: the approval bot is not configured. The owner has to create a bot with BotFather and set TG_MCP_APPROVAL_BOT_TOKEN.',
      );
    }
    const user = this.storage.users.get(request.userId);
    if (!user?.telegramId) {
      throw new GatewayError(
        'UNAVAILABLE',
        `Write actions are not available for user "${request.userId}": no Telegram id is set for approvals. The owner has to run: tg-mcp user telegram ${request.userId} <telegram id>.`,
      );
    }

    const approval = this.store.createApproval({
      id: `ap_${randomBytes(5).toString('hex')}`,
      userId: request.userId,
      accountId: request.accountId,
      kind: request.kind,
      source: request.source,
      payload: request.payload,
      preview: request.title,
      expiresAt: this.now() + (request.ttlMs ?? this.defaultTtlMs),
    });

    try {
      const sent = await this.bot.sendMessage(user.telegramId, this.cardText(approval), { buttons: this.buttons(approval, entry) });
      this.store.updateApproval(approval.id, { botChatId: user.telegramId, botMessageId: sent.message_id });
    } catch (err) {
      this.store.transitionApproval(approval.id, ['pending'], 'failed');
      this.store.updateApproval(approval.id, { result: { error: (err as Error).message } });
      if (err instanceof BotApiError && err.cannotReach) {
        throw new GatewayError(
          'UNAVAILABLE',
          'The approval bot cannot message the owner: they have to open the bot in Telegram and press Start first.',
          { cause: err },
        );
      }
      throw new GatewayError('UNAVAILABLE', `Could not deliver the approval request to the owner: ${(err as Error).message}`, { cause: err });
    }
    return this.store.getApproval(approval.id)!;
  }

  private cardText(approval: ApprovalRecord, footer?: string): string {
    const account = approval.accountId ? this.storage.accounts.get(approval.accountId) : null;
    const lines = [`Согласование ${approval.id}`, approval.preview];
    if (account) lines.push(`Аккаунт: ${account.id}${account.username ? ` (@${account.username})` : ''}`);
    if (approval.source !== 'tool') lines.push(`Источник: ${approval.source}`);
    const text = approval.payload.text;
    if (typeof text === 'string' && text) {
      lines.push('', 'Текст:', truncate(sanitizeText(text), DRAFT_MAX_CHARS));
    }
    if (footer) lines.push('', footer);
    return lines.join('\n');
  }

  private buttons(approval: ApprovalRecord, entry: ExecutorEntry): InlineButton[][] {
    const row: InlineButton[] = [{ text: entry.approveLabel, data: `ap:${approval.id}:ok` }];
    if (entry.editable) row.push({ text: '✏️ Изменить', data: `ap:${approval.id}:edit` });
    row.push({ text: entry.rejectLabel, data: `ap:${approval.id}:no` });
    return [row];
  }

  // ---------- обновления бота ----------

  async handleUpdate(update: BotUpdate): Promise<void> {
    for (const handler of this.updateHandlers) {
      if (await handler(update)) return;
    }
    if (update.callback_query) return this.handleCallback(update.callback_query);
    if (update.message) return this.handleMessage(update.message);
  }

  private async handleCallback(query: BotCallbackQuery): Promise<void> {
    const bot = this.bot!;
    const m = (query.data ?? '').match(/^ap:(ap_[0-9a-f]+):(ok|edit|no)$/);
    if (!m) return bot.answerCallbackQuery(query.id);
    const approval = this.store.getApproval(m[1]!);
    const action = m[2]!;
    const user = approval ? this.storage.users.get(approval.userId) : null;

    // Решает только тот, чьё это действие. Чужое нажатие ничего не меняет.
    if (!approval || !user?.telegramId || String(query.from.id) !== user.telegramId) {
      return bot.answerCallbackQuery(query.id, 'Это согласование не для вас.');
    }
    if (approval.state !== 'pending' && approval.state !== 'awaiting_edit') {
      return bot.answerCallbackQuery(query.id, `Уже решено: ${this.stateLabel(approval.state)}.`);
    }

    if (action === 'no') {
      if (!this.store.transitionApproval(approval.id, ['pending', 'awaiting_edit'], 'rejected')) return bot.answerCallbackQuery(query.id);
      await bot.answerCallbackQuery(query.id, 'Пропущено');
      await this.finishCard(approval.id, '🚫 Пропущено');
      this.notify(approval.id);
      return;
    }

    if (action === 'edit') {
      const entry = this.executors.get(approval.kind);
      if (!entry?.editable) return bot.answerCallbackQuery(query.id, 'Этот запрос нельзя изменить.');
      if (!this.store.transitionApproval(approval.id, ['pending'], 'awaiting_edit')) return bot.answerCallbackQuery(query.id);
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(user.telegramId, `Пришли новый текст для ${approval.id} одним сообщением. Он уйдёт сразу.`, {
        replyTo: approval.botMessageId ?? undefined,
        forceReply: true,
      });
      return;
    }

    await bot.answerCallbackQuery(query.id, 'Выполняю');
    await this.execute(approval.id);
  }

  private async handleMessage(message: BotMessage): Promise<void> {
    const bot = this.bot!;
    if (message.chat.type !== 'private' || !message.from) return;
    const fromId = String(message.from.id);
    const text = (message.text ?? '').trim();

    if (text === '/start' || text === '/id') {
      const known = this.storage.users.list().find(u => u.telegramId === fromId);
      await bot.sendMessage(
        message.chat.id,
        known
          ? `Это бот согласований tg-mcp. Вы пользователь шлюза «${known.id}». Сюда будут приходить запросы на отправку сообщений.`
          : `Это бот согласований tg-mcp. Ваш Telegram id: ${fromId}. Владелец шлюза должен привязать его: tg-mcp user telegram <пользователь> ${fromId}`,
      );
      return;
    }

    const awaiting = this.store.approvalAwaitingEdit(String(message.chat.id));
    const user = awaiting ? this.storage.users.get(awaiting.userId) : null;
    if (!awaiting || user?.telegramId !== fromId || !text) return;

    this.store.updateApproval(awaiting.id, { payload: { ...awaiting.payload, text, editedByOwner: true } });
    await this.execute(awaiting.id);
  }

  /** Выполняет одобренное действие. Двойное нажатие не выполнит его дважды. */
  private async execute(id: string): Promise<void> {
    if (!this.store.transitionApproval(id, ['pending', 'awaiting_edit'], 'executing')) return;
    const approval = this.store.getApproval(id)!;
    const entry = this.executors.get(approval.kind);
    try {
      if (!entry) throw new GatewayError('INVALID_ARGUMENT', `No executor for "${approval.kind}".`);
      const outcome = await entry.run(approval);
      this.store.updateApproval(id, { state: 'executed', result: { summary: outcome.summary, ...(outcome.data ?? {}) } });
      await this.finishCard(id, `✅ ${outcome.summary}`);
    } catch (err) {
      const message = isGatewayError(err) ? `${err.code}: ${err.message}` : (err as Error).message;
      this.log.warn('approved action failed', { approval: id, kind: approval.kind, error: message });
      this.store.updateApproval(id, { state: 'failed', result: { error: message } });
      await this.finishCard(id, `⚠️ Не выполнено: ${message}`);
    }
    this.notify(id);
  }

  private async finishCard(id: string, footer: string): Promise<void> {
    const approval = this.store.getApproval(id);
    if (!approval?.botChatId || !approval.botMessageId || !this.bot) return;
    try {
      await this.bot.editMessageText(approval.botChatId, approval.botMessageId, this.cardText(approval, footer));
    } catch (err) {
      this.log.warn('could not update the approval card', { approval: id, error: (err as Error).message });
    }
  }

  /** Событие во входящие: агент узнаёт исход через tg_inbox. */
  private notify(id: string): void {
    const approval = this.store.getApproval(id);
    if (!approval) return;
    this.store.addInbox({
      userId: approval.userId,
      kind: 'approval',
      accountId: approval.accountId,
      chatKey: typeof approval.payload.chatKey === 'string' ? approval.payload.chatKey : null,
      messageId: typeof approval.payload.postId === 'number' ? approval.payload.postId : null,
      payload: { approval_id: approval.id, action: approval.kind, state: approval.state, source: approval.source, result: approval.result ?? {} },
    });
  }

  private stateLabel(state: ApprovalRecord['state']): string {
    const labels: Record<ApprovalRecord['state'], string> = {
      pending: 'ждёт решения',
      awaiting_edit: 'ждёт нового текста',
      executing: 'выполняется',
      executed: 'выполнено',
      rejected: 'пропущено',
      expired: 'истекло',
      failed: 'не выполнено',
    };
    return labels[state];
  }

  /** Закрывает просроченные согласования. */
  async sweep(): Promise<number> {
    const expired = this.store.expireApprovals();
    for (const approval of expired) {
      await this.finishCard(approval.id, '⌛ Истекло без решения');
      this.notify(approval.id);
    }
    return expired.length;
  }

  status(id: string, userId: string): ApprovalRecord {
    const approval = this.store.getApproval(id);
    if (!approval || approval.userId !== userId) throw new GatewayError('NOT_FOUND', `Approval "${id}" not found.`);
    return approval;
  }

  /**
   * Цикл приёма обновлений бота. У токена может быть только один получатель:
   * при конфликте (409) цикл ждёт и пишет в лог, а не спорит с другим процессом.
   */
  async poll(signal: AbortSignal): Promise<void> {
    if (!this.bot) return;
    const key = 'bot.offset';
    let offset = Number(this.storage.kv.get(key) ?? '0') || 0;
    while (!signal.aborted) {
      try {
        const updates = await this.bot.getUpdates(offset, 25, signal);
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          this.storage.kv.set(key, String(offset));
          try {
            await this.handleUpdate(update);
          } catch (err) {
            this.log.error('bot update failed', { error: (err as Error).message });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof BotApiError && err.isConflict) {
          this.log.error('another process is polling the approval bot token: approvals will not arrive until it stops');
          await sleep(30_000);
        } else {
          this.log.warn('bot polling failed', { error: (err as Error).message });
          await sleep(5_000);
        }
      }
    }
  }
}
