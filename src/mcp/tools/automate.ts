/**
 * Наборы `automate` и `write`: наблюдение, входящие, правила и действия.
 *
 * Наблюдение ничего не пишет в Telegram и работает сразу (решение 15).
 * Всё, что пишет, уходит человеку на согласование в бота: инструмент
 * возвращает `approval_id`, а действие выполняет шлюз после нажатия кнопки.
 */
import { z } from 'zod';
import { assertRuleId, describeRule, normalizeRuleConfig, RULE_PER_DAY_MAX, ruleKey, ruleName } from '../../automation/rules.js';
import type { ApprovalRecord, InboxEvent } from '../../automation/store.js';
import { GatewayError } from '../../core/errors.js';
import { createEnvelope, safeLabel } from '../../policy/envelope.js';
import { messageLink, parseRef } from '../../services/links.js';
import { assertMessageText } from '../../services/write.js';
import { clampLimit } from '../args.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { formatDate } from '../format.js';
import { defineTool, type ToolContext, type ToolDef } from '../tool.js';
import { accountArg, chatArg, chatLabel, locateMessage } from './shared.js';

function pendingNote(approval: ApprovalRecord): string {
  return [
    `Sent to the owner for approval: approval_id ${approval.id}.`,
    'Nothing has been done in Telegram yet. The gateway performs the action itself after the owner taps the button in the approval bot.',
    'Do not repeat this call. The outcome appears in tg_inbox as an "approval" event.',
  ].join('\n');
}

const tgWatch = defineTool({
  name: 'tg_watch',
  toolset: 'automate',
  title: 'Watch chats for new posts',
  description:
    'Manage the list of chats watched for new posts: add, remove, list. Works for any public channel or group, and for private ones the account has joined. New posts appear in tg_inbox. Watching writes nothing to Telegram and needs no approval.',
  input: {
    action: z.enum(['add', 'remove', 'list']).describe('What to do.'),
    chat: z.string().optional().describe('Chat to add or remove: @username, t.me link or id.'),
    account: accountArg,
  },
  readOnly: true,
  handler: async (args, ctx) => {
    const { automation, runtime } = ctx.services;
    const userId = ctx.principal.userId;

    if (args.action === 'list') {
      const watches = automation.store.listWatches(userId).filter(w => ctx.principal.accounts.includes(w.accountId));
      const lines = [`Watched chats: ${watches.length}`];
      for (const w of watches) {
        const chat = runtime.storage.entities.get(w.accountId, w.chatKey);
        const state = automation.store.watchState(w.accountId, w.chatKey);
        lines.push(
          [
            chat ? chatLabel(chat) : `id ${w.chatKey}`,
            `account ${w.accountId}`,
            state?.lastPollAt ? `last check ${formatDate(Math.floor(state.lastPollAt / 1000))}` : 'not checked yet',
            state ? `every ${Math.round(state.intervalMs / 1000)}s` : '',
            state?.lastError ? `PROBLEM: ${state.lastError}` : '',
          ]
            .filter(Boolean)
            .join(' | '),
        );
      }
      return { text: lines.join('\n'), count: watches.length };
    }

    if (!args.chat) throw new GatewayError('INVALID_ARGUMENT', `"chat" is required for action=${args.action}.`);
    const accountId = ctx.account(args.account);
    const { chat } = await ctx.openChat(args.chat, accountId);
    if (chat.kind === 'user') {
      throw new GatewayError('INVALID_ARGUMENT', 'Only channels and groups can be watched. A conversation with a person is a task: see tg_task_start.');
    }

    if (args.action === 'add') {
      const result = automation.watcher.add(userId, accountId, chat);
      return {
        accountId,
        peerKey: chat.peerKey,
        text: [
          result.created ? `Now watching ${chatLabel(chat)} with account ${accountId}.` : `${chatLabel(chat)} is already watched with account ${accountId}.`,
          'Only posts published from now on are reported; read earlier ones with tg_read_history.',
          `This account watches ${result.watched} chat(s). Read new posts with tg_inbox.`,
        ].join('\n'),
      };
    }

    const removed = automation.watcher.remove(userId, accountId, chat.peerKey);
    return { accountId, peerKey: chat.peerKey, text: removed ? `Stopped watching ${chatLabel(chat)}.` : `${chatLabel(chat)} was not on your watch list.` };
  },
});

function formatEvent(event: InboxEvent, ctx: ToolContext, env: ReturnType<typeof createEnvelope>): string[] {
  const when = formatDate(Math.floor(event.ts / 1000));
  const p = event.payload as Record<string, unknown>;
  const chat = event.accountId && event.chatKey ? ctx.services.runtime.storage.entities.get(event.accountId, event.chatKey) : null;
  const where = chat ? chatLabel(chat) : typeof p.chat === 'string' ? String(p.chat) : event.chatKey ? `id ${event.chatKey}` : '';

  switch (event.kind) {
    case 'new_post': {
      const head = [`event ${event.id}`, when, 'new_post', `in ${where}`, `#${event.messageId}`, p.media ? `[${String(p.media)}]` : '', typeof p.link === 'string' ? p.link : '']
        .filter(Boolean)
        .join(' | ');
      return typeof p.preview === 'string' && p.preview ? [head, env.inline(p.preview, 320)] : [head];
    }
    case 'approval': {
      const result = (p.result ?? {}) as Record<string, unknown>;
      const detail = typeof result.summary === 'string' ? result.summary : typeof result.error === 'string' ? result.error : '';
      return [
        [`event ${event.id}`, when, 'approval', String(p.approval_id), `${String(p.action)} ${String(p.state)}`, where ? `in ${where}` : '', detail]
          .filter(Boolean)
          .join(' | '),
      ];
    }
    case 'agent_run':
      return [
        [`event ${event.id}`, when, 'agent_run', p.rule ? `rule ${String(p.rule)}` : p.task ? `task ${String(p.task)}` : '', where ? `in ${where}` : '', `exit code ${String(p.exit_code)}`]
          .filter(Boolean)
          .join(' | '),
      ];
    default:
      return [[`event ${event.id}`, when, event.kind, where ? `in ${where}` : ''].filter(Boolean).join(' | ')];
  }
}

const tgInbox = defineTool({
  name: 'tg_inbox',
  toolset: 'automate',
  title: 'Read new events',
  description:
    'Events since the cursor: new posts in watched chats, outcomes of approvals, runs of your rules. Without a cursor returns the latest events. Always returns next_cursor: pass it next time to get only newer events.',
  input: {
    cursor: z.string().optional().describe('next_cursor from the previous tg_inbox call.'),
    limit: z.number().int().optional().describe('Default 20, max 50.'),
  },
  readOnly: true,
  handler: async (args, ctx) => {
    const { store } = ctx.services.automation;
    const userId = ctx.principal.userId;
    const limit = clampLimit(args.limit, 20, 50);
    const latest = store.latestInboxId(userId);
    const after = args.cursor ? decodeCursor<{ o: number }>('inbox', args.cursor).o : Math.max(0, latest - limit);

    const { scopes, runtime } = ctx.services;
    const scanned = store.inboxAfter(userId, after, limit);
    const events = scanned.filter(e => {
      if (e.accountId !== null && !ctx.principal.accounts.includes(e.accountId)) return false;
      if (e.kind !== 'new_post') return true;
      // Доступ к чату могли закрыть уже после события: такие посты не показываются.
      const chat = e.accountId && e.chatKey ? runtime.storage.entities.get(e.accountId, e.chatKey) : null;
      return chat !== null && scopes.isAllowed(userId, e.accountId!, chat);
    });
    const env = createEnvelope();
    const lines = [`Inbox: ${events.length} event(s)`];
    if (events.some(e => e.kind === 'new_post')) lines.push(env.notice(), 'Times are UTC.');
    for (const event of events) lines.push(...formatEvent(event, ctx, env));
    if (events.length === 0) lines.push('Nothing new.');

    // Курсор двигается по всем просмотренным событиям, включая отфильтрованные: иначе он застрял бы на них.
    const lastId = scanned.length > 0 ? scanned[scanned.length - 1]!.id : after;
    lines.push('', `next_cursor: ${encodeCursor('inbox', { o: lastId })}`);
    if (lastId < latest) lines.push('There are more events: call tg_inbox again with this cursor.');
    return { text: lines.join('\n'), count: events.length };
  },
});

const tgRuleSet = defineTool({
  name: 'tg_rule_set',
  toolset: 'automate',
  title: 'Create or change a monitoring rule',
  description:
    'A rule watches a chat and, on each new post, starts the owner\'s agent with your prompt to draft a reply in comments; every draft still goes to the owner for approval. Creating or changing a rule needs the owner\'s approval in Telegram. enabled=false switches a rule off at once.',
  input: {
    id: z.string().describe('Rule id: lowercase letters, digits, "-" or "_".'),
    chat: z.string().optional().describe('Chat to watch. Required for a new rule.'),
    prompt: z.string().optional().describe('What the agent should do with a new post. Required for a new rule.'),
    keywords: z.array(z.string()).optional().describe('React only to posts containing one of these words. Default: all posts.'),
    skip_ads: z.boolean().optional().describe('Skip advertising posts. Default true.'),
    per_day: z.number().int().optional().describe(`Maximum agent runs per day: default 5, max ${RULE_PER_DAY_MAX}.`),
    quiet_hours: z.string().optional().describe('Hours with no runs, UTC, like 23:00-09:00.'),
    send_as: z.enum(['account', 'channel']).optional().describe('Reply as the account (default) or as the channel, if the account is its admin.'),
    enabled: z.boolean().optional().describe('false switches the rule off without approval.'),
    account: accountArg,
  },
  readOnly: false,
  handler: async (args, ctx) => {
    const { automation, runtime } = ctx.services;
    const userId = ctx.principal.userId;
    const id = assertRuleId(args.id);
    // Имена правил у каждого пользователя свои: чужое правило с тем же именем здесь не видно.
    const key = ruleKey(userId, id);
    const existing = automation.store.getRule(key);

    if (args.enabled === false) {
      if (!existing) throw new GatewayError('NOT_FOUND', `You have no rule "${id}".`);
      automation.store.setRuleEnabled(key, false);
      // Запуски агента, которые ещё ждут своей паузы, тоже отменяются.
      automation.store.cancelPendingRunnerJobs('rule', 'ruleId', key);
      return { accountId: existing.accountId, peerKey: existing.chatKey, text: `Rule "${id}" is switched off. Its chat stays on the watch list; remove it with tg_watch if not needed.` };
    }

    if (!runtime.config.toolsets.includes('write')) {
      throw new GatewayError('UNAVAILABLE', 'Rules that reply need the "write" toolset, and the owner has not enabled it (TG_MCP_TOOLSETS).');
    }

    const accountId = args.account ? ctx.account(args.account) : (existing?.accountId ?? ctx.account());
    const chatRef = args.chat ?? existing?.chatKey;
    if (!chatRef) throw new GatewayError('INVALID_ARGUMENT', 'A new rule needs "chat".');
    const { chat } = await ctx.openChat(chatRef, accountId);
    const config = normalizeRuleConfig({
      prompt: args.prompt ?? existing?.config.prompt ?? '',
      keywords: args.keywords ?? existing?.config.keywords,
      skipAds: args.skip_ads ?? existing?.config.skipAds,
      perDay: args.per_day ?? existing?.config.perDay,
      quietHours: args.quiet_hours ?? existing?.config.quietHours ?? undefined,
      delaySec: existing?.config.delaySec,
      sendAs: args.send_as ?? existing?.config.sendAs,
    });

    const rule = { id: key, userId, accountId, chatKey: chat.peerKey, config };
    const approval = await automation.approvals.request({
      userId,
      accountId,
      kind: 'rule',
      source: 'tool',
      payload: { rule, chatKey: chat.peerKey },
      title: describeRule(rule, chatLabel(chat)),
    });
    return { accountId, peerKey: chat.peerKey, text: `Rule "${id}" for ${chatLabel(chat)} is ${existing ? 'changed' : 'created'} but NOT active yet.\n${pendingNote(approval)}` };
  },
});

const tgRules = defineTool({
  name: 'tg_rules',
  toolset: 'automate',
  title: 'List monitoring rules',
  description: 'Your rules and the rules of other users on accounts you share: chat, state, limits and the latest runs.',
  input: {},
  readOnly: true,
  handler: async (_args, ctx) => {
    const { store } = ctx.services.automation;
    const userId = ctx.principal.userId;
    const rules = store.rulesVisibleTo(userId).filter(r => ctx.principal.accounts.includes(r.accountId));
    const dayStart = ctx.now() - (ctx.now() % 86_400_000);
    const lines = [`Rules: ${rules.length}`];
    for (const rule of rules) {
      const chat = ctx.services.runtime.storage.entities.get(rule.accountId, rule.chatKey);
      lines.push(
        [
          `rule ${ruleName(rule.id)}`,
          chat ? chatLabel(chat) : `id ${rule.chatKey}`,
          `account ${rule.accountId}`,
          rule.enabled ? 'ON' : 'off',
          rule.userId === userId ? 'yours' : `by ${rule.userId} (read only)`,
          `runs today ${store.firesSince(rule.id, dayStart)}/${rule.config.perDay}`,
          rule.config.keywords.length > 0 ? `keywords: ${rule.config.keywords.join(', ')}` : '',
          rule.config.quietHours ? `quiet ${rule.config.quietHours} UTC` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      );
      for (const fire of store.lastFires(rule.id, 3)) {
        lines.push(`  post #${fire.messageId} at ${formatDate(Math.floor(fire.ts / 1000))}: ${fire.outcome}`);
      }
    }
    const pending = store.pendingRunnerJobs(userId);
    if (pending > 0) lines.push('', `${pending} agent run(s) are waiting for your runner (tg-mcp runner).`);
    return { text: lines.join('\n'), count: rules.length };
  },
});

const tgReply = defineTool({
  name: 'tg_reply',
  toolset: 'write',
  title: 'Reply in comments to a post',
  description:
    'Drafts a reply in the comments of a channel post and sends the draft to the owner for approval in Telegram. Nothing is posted until the owner taps Send. One reply per post per account.',
  input: {
    link: z.string().optional().describe('t.me link to the post.'),
    chat: z.string().optional().describe('Channel, when "link" is not given.'),
    id: z.number().int().positive().max(2_147_483_647).optional().describe('Post id, when "link" is not given.'),
    text: z.string().describe('Reply text, plain text, up to 2800 characters.'),
    send_as: z.enum(['account', 'channel']).optional().describe('Reply as the account (default) or as the channel, if the account is its admin.'),
    account: accountArg,
  },
  readOnly: false,
  handler: async (args, ctx) => {
    const { automation } = ctx.services;
    const text = assertMessageText(args.text);
    const where = await locateMessage(ctx, args);
    const post = where.commentOf ?? { chat: where.chat, postId: where.messageId };
    const grant = ctx.principal.grant;

    if (grant && (!grant.reply || grant.reply.chatKey !== post.chat.peerKey || grant.reply.postId !== post.postId)) {
      throw new GatewayError('ACCESS_DENIED', 'This run may reply only to the post it was started for.');
    }
    if (post.chat.kind !== 'channel') {
      throw new GatewayError('INVALID_ARGUMENT', 'tg_reply answers in the comments of a channel post. For other chats use tg_send.');
    }

    automation.write.assertCanReply(where.accountId, post.chat.peerKey, post.postId);
    const waiting = automation.store
      .listApprovals(ctx.principal.userId, ['pending', 'awaiting_edit', 'executing'], 100)
      .find(a => a.kind === 'reply' && a.payload.accountId === where.accountId && a.payload.chatKey === post.chat.peerKey && a.payload.postId === post.postId);
    if (waiting) {
      throw new GatewayError('LIMIT_REACHED', `A reply to this post is already waiting for the owner's approval (${waiting.id}). Do not send another one.`);
    }

    const link = messageLink({ username: post.chat.username, peerKey: post.chat.peerKey, messageId: post.postId }) ?? `#${post.postId} в ${chatLabel(post.chat)}`;
    // Агент, запущенный по правилу, отвечает так, как записано в правиле, а не как решит сам.
    const sendAs = grant ? (grant.reply?.sendAs ?? 'account') : (args.send_as ?? 'account');
    const approval = await automation.approvals.request({
      userId: ctx.principal.userId,
      accountId: where.accountId,
      kind: 'reply',
      source: grant?.ruleId ? `rule:${grant.ruleId}` : 'tool',
      payload: { accountId: where.accountId, chatKey: post.chat.peerKey, postId: post.postId, text, sendAs, link },
      title: `Ответ в комментариях к посту ${link}${sendAs === 'channel' ? ' (от имени канала)' : ''}`,
    });
    return { accountId: where.accountId, peerKey: post.chat.peerKey, text: `Reply to post #${post.postId} of ${chatLabel(post.chat)} is drafted.\n${pendingNote(approval)}` };
  },
});

const tgJoin = defineTool({
  name: 'tg_join',
  toolset: 'write',
  title: 'Join a chat',
  description:
    'Asks the owner to approve joining a channel or group (public or by invite link). The gateway never passes captchas of gatekeeper bots: if the chat asks for one, the owner has to do it.',
  input: { ref: chatArg, account: accountArg },
  readOnly: false,
  handler: async (args, ctx) => {
    const { automation, resolver } = ctx.services;
    const accountId = ctx.account(args.account);
    const parsed = parseRef(args.ref);

    let payload: Record<string, unknown>;
    let label: string;
    if (parsed.chat.type === 'invite') {
      const invite = await resolver.invite(accountId, parsed.chat.hash);
      if (invite.member) return { accountId, text: 'The account is already a member of this chat.' };
      label = `закрытый чат «${safeLabel(invite.title, 60) || 'без названия'}»${invite.members ? `, участников: ${invite.members}` : ''}${invite.requestNeeded ? ' (вступление по заявке)' : ''}`;
      payload = { accountId, inviteHash: parsed.chat.hash, label };
    } else {
      const { chat } = await ctx.openChat(args.ref, accountId);
      if (chat.kind !== 'channel') throw new GatewayError('INVALID_ARGUMENT', 'Only channels and supergroups can be joined.');
      const card = await resolver.card(accountId, chat);
      if (card.isMember === true) return { accountId, peerKey: chat.peerKey, text: `The account is already a member of ${chatLabel(chat)}.` };
      label = `${chatLabel(chat)} (${card.type}${card.members !== null ? `, участников: ${card.members}` : ''})`;
      payload = { accountId, chatKey: chat.peerKey, label };
    }

    const approval = await automation.approvals.request({
      userId: ctx.principal.userId,
      accountId,
      kind: 'join',
      source: 'tool',
      payload,
      title: `Вступить в ${label}`,
    });
    return { accountId, text: `Joining is requested.\n${pendingNote(approval)}` };
  },
});

export const AUTOMATE_TOOLS: ToolDef[] = [tgWatch, tgInbox, tgRuleSet, tgRules] as unknown as ToolDef[];
export const WRITE_TOOLS: ToolDef[] = [tgReply, tgJoin] as unknown as ToolDef[];
