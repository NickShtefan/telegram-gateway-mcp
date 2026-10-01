/**
 * Сборка автоматизации: наблюдатель, правила, подтверждение записи, очередь
 * запусков агента и запись. Работает, пока агент не запущен; правило это разрешение,
 * выданное заранее.
 */
import { GatewayError } from '../core/errors.js';
import type { Runtime } from '../runtime.js';
import type { CommentsService } from '../services/comments.js';
import type { HistoryService } from '../services/history.js';
import { WriteService } from '../services/write.js';
import type { EntityRecord } from '../storage/port.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Approvals } from './approvals.js';
import { ScopePolicy } from '../policy/scopes.js';
import { RuleEngine, ruleKey, ruleName } from './rules.js';
import { RunnerQueue } from './runner.js';
import { AutomationStore, type RuleRecord } from './store.js';
import { TaskEngine } from './tasks.js';
import { TaskStore } from './taskStore.js';
import { Watcher } from './watcher.js';

export interface Automation {
  store: AutomationStore;
  approvals: Approvals;
  watcher: Watcher;
  rules: RuleEngine;
  runner: RunnerQueue;
  write: WriteService;
  tasks: TaskEngine;
  taskStore: TaskStore;
}

export interface AutomationDeps {
  runtime: Runtime;
  history: HistoryService;
  comments: CommentsService;
  now?: () => number;
}

export function buildAutomation(deps: AutomationDeps): Automation {
  const { runtime } = deps;
  const { storage, log } = runtime;
  if (!(storage instanceof SqliteStorage)) {
    throw new GatewayError('UNAVAILABLE', 'Automation needs the SQLite storage.');
  }
  const now = deps.now ?? (() => Date.now());
  const store = new AutomationStore(storage, now);

  const approvals = new Approvals({ store, log: log.child('approvals'), now });
  const write = new WriteService({ tg: runtime.tg, store, comments: deps.comments, now, log: log.child('write') });
  const rules = new RuleEngine({ store, log: log.child('rules'), now });
  const scopes = new ScopePolicy(storage);
  const runner = new RunnerQueue({ store, log: log.child('runner'), now });
  const watcher = new Watcher({
    store,
    storage,
    history: deps.history,
    onNewPost: event => void rules.onNewPost(event),
    allowed: (userId, accountId, chat) => scopes.isAllowed(userId, accountId, chat),
    onStuck: reason => runtime.fatal(reason),
    log: log.child('watcher'),
    now,
  });

  const chatOf = (accountId: string, chatKey: string): EntityRecord => {
    const chat = storage.entities.get(accountId, chatKey);
    if (!chat) throw new GatewayError('CHAT_NOT_FOUND', `Chat ${chatKey} is no longer known to account ${accountId}.`);
    return chat;
  };

  approvals.register(
    'reply',
    async approval => {
      const p = approval.payload as { accountId: string; chatKey: string; postId: number; text: string; sendAs?: 'account' | 'channel' };
      const sent = await write.reply({ userId: approval.userId, accountId: p.accountId, source: approval.source }, chatOf(p.accountId, p.chatKey), p.postId, p.text, p.sendAs ?? 'account');
      return { summary: sent.link ? `Sent: ${sent.link}` : 'Sent', data: { link: sent.link, message_id: sent.messageId } };
    },
    { editable: true },
  );

  approvals.register('react', async approval => {
    const p = approval.payload as { accountId: string; chatKey: string; messageId: number; emoji: string | null; where: string };
    await write.react({ userId: approval.userId, accountId: p.accountId, source: approval.source }, chatOf(p.accountId, p.chatKey), p.messageId, p.emoji);
    return { summary: p.emoji ? `Reaction ${p.emoji} is set on ${p.where}` : `The reaction is removed from ${p.where}` };
  });

  approvals.register(
    'join',
    async approval => {
      const p = approval.payload as { accountId: string; chatKey?: string; inviteHash?: string; label: string };
      const joined = await write.join(
        { userId: approval.userId, accountId: p.accountId, source: approval.source },
        { chat: p.chatKey ? chatOf(p.accountId, p.chatKey) : undefined, inviteHash: p.inviteHash },
      );
      if (joined.outcome === 'requested') return { summary: `A join request to ${p.label} is sent: an admin of the chat has to accept it.`, data: { outcome: joined.outcome } };
      if (joined.outcome === 'already') return { summary: `The account is already a member of ${p.label}.`, data: { outcome: joined.outcome } };
      return { summary: `The account joined ${p.label}. If the chat asks to pass a check, the owner has to do it.`, data: { outcome: joined.outcome } };
    },
  );

  approvals.register(
    'rule',
    async approval => {
      const rule = approval.payload.rule as Pick<RuleRecord, 'id' | 'userId' | 'accountId' | 'chatKey' | 'config'>;
      // Правило включается только на имя того, кто его подтвердил.
      if (rule.userId !== approval.userId || rule.id !== ruleKey(approval.userId, ruleName(rule.id))) {
        throw new GatewayError('ACCESS_DENIED', 'The rule does not belong to the user who approved it.');
      }
      store.putRule({ ...rule, enabled: true });
      // Правило без наблюдения не сработает: чат добавляется в список автора.
      store.addWatch(rule.userId, rule.accountId, rule.chatKey);
      return { summary: `Rule "${ruleName(rule.id)}" is switched on`, data: { rule: ruleName(rule.id) } };
    },
  );

  const taskStore = new TaskStore(storage, now);
  const tasks = new TaskEngine({ tasks: taskStore, store, storage, history: deps.history, write, approvals, runner, log: log.child('tasks'), now });

  return { store, approvals, watcher, rules, runner, write, tasks, taskStore };
}
