/**
 * Каркас инструментов. Инструмент объявляется один раз и не знает о транспорте
 * (по образцу channel-scope `packages/mcp/src/index.ts`: registerTool, zod,
 * readOnlyHint). Обёртка добавляет то, что одинаково для всех: аудит, ошибки
 * в виде `isError` с понятным текстом и `retry_after`, контекст пользователя.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { classifyError, GatewayError, isGatewayError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import type { Principal } from '../policy/access.js';
import type { GatewayServices } from '../services/index.js';
import type { EntityRecord } from '../storage/port.js';
import type { ParsedRef } from '../services/links.js';

export interface ToolImage {
  /** base64 */
  data: string;
  mimeType: string;
}

export interface ToolOutput {
  text: string;
  images?: ToolImage[];
  /** Для аудита: какой аккаунт и чат затронуты, сколько сообщений отдано. */
  accountId?: string | null;
  peerKey?: string | null;
  count?: number | null;
}

export interface ToolContext {
  services: GatewayServices;
  principal: Principal;
  log: Logger;
  now(): number;
  /** Аккаунт вызова: запрошенный или по умолчанию, с проверкой доступа. */
  account(requested?: string): string;
  /**
   * Находит чат по ссылке, username или id и проверяет скоупы пользователя.
   * `allowUsers` открывает карточку человека (но не его переписку).
   */
  openChat(ref: string, accountId: string): Promise<{ parsed: ParsedRef; chat: EntityRecord }>;
}

export type ToolShape = Record<string, z.ZodTypeAny>;

export interface ToolDef<S extends ToolShape = ToolShape> {
  name: string;
  toolset: string;
  /** Инструмент доступен при любом составе наборов: состояние шлюза агент видит всегда. */
  always?: boolean;
  title: string;
  description: string;
  input: S;
  /** Инструмент ничего не меняет в Telegram. */
  readOnly: boolean;
  handler(args: { [K in keyof S]: z.infer<S[K]> }, context: ToolContext): Promise<ToolOutput>;
}

/** Помогает TypeScript вывести типы аргументов из схемы. */
export function defineTool<S extends ToolShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Текст ошибки для агента: код, объяснение и, если есть, когда повторить. */
export function formatToolError(err: GatewayError): string {
  const lines = [`Error: ${err.code}`, err.message];
  if (err.retryAfter !== undefined) lines.push(`retry_after: ${err.retryAfter}`);
  if (err.outcomeUnknown) lines.push('outcome: unknown');
  return lines.join('\n');
}

/** Любая ошибка -> GatewayError. Ошибки самого шлюза (баги) не выдаются за ошибки Telegram. */
export function toGatewayError(err: unknown, log: Logger, tool: string): GatewayError {
  if (isGatewayError(err)) return err;
  const looksLikeTelegram =
    typeof err === 'object' && err !== null && ('errorMessage' in err || 'seconds' in err || /[A-Z]{3,}_[A-Z_]+/.test((err as Error).message ?? ''));
  if (looksLikeTelegram || (err as Error)?.name === 'DeadlineError') return classifyError(err);
  log.error('tool failed with an internal error', { tool, error: (err as Error)?.stack ?? String(err) });
  return new GatewayError('UNAVAILABLE', `Internal gateway error in ${tool}: ${(err as Error)?.message ?? 'unknown'}. This is a bug in the gateway, not in your request.`);
}

export interface RegisterOptions {
  services: GatewayServices;
  principal: Principal;
  toolsets: string[];
  log: Logger;
  now?: () => number;
}

export function createToolContext(options: RegisterOptions): ToolContext {
  const { services, principal } = options;
  const now = options.now ?? (() => Date.now());
  return {
    services,
    principal,
    log: options.log,
    now,
    account: requested => services.access.resolveAccount(principal, requested || undefined),
    openChat: async (ref, accountId) => {
      const found = await services.resolver.resolve(accountId, ref);
      if (principal.grant && !principal.grant.chatKeys.includes(found.chat.peerKey)) {
        throw new GatewayError('ACCESS_DENIED', 'This run may only work with the chat it was started for.');
      }
      const decision = services.scopes.decide(principal.userId, accountId, found.chat);
      // Личный диалог поручения открыт только токену его запуска: общего правила для пользователя нет.
      const ownDialog = principal.grant !== undefined && !decision.allowed && decision.code === 'private';
      if (!decision.allowed && !ownDialog) throw new GatewayError('ACCESS_DENIED', decision.reason);
      return found;
    },
  };
}

/** Регистрирует инструменты включённых наборов на сервере одного пользователя. */
export function registerTools(server: McpServer, tools: ToolDef[], options: RegisterOptions): string[] {
  const context = createToolContext(options);
  const registered: string[] = [];

  for (const tool of tools) {
    if (!tool.always && !options.toolsets.includes(tool.toolset)) continue;
    // Агент, запущенный по правилу или поручению, видит только инструменты своего дела.
    if (options.principal.grant && !options.principal.grant.tools.includes(tool.name)) continue;
    registered.push(tool.name);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          // Telegram это внешний мир: содержимое ответов не контролируется шлюзом.
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        const startedAt = context.now();
        try {
          const output = await tool.handler(args as never, context);
          options.services.audit.record({
            userId: options.principal.userId,
            accountId: output.accountId ?? null,
            tool: tool.name,
            args,
            peerKey: output.peerKey ?? null,
            resultCount: output.count ?? null,
            startedAt,
          });
          return {
            content: [
              { type: 'text' as const, text: output.text },
              ...(output.images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
            ],
          };
        } catch (err) {
          const error = toGatewayError(err, options.log, tool.name);
          options.services.audit.record({
            userId: options.principal.userId,
            accountId: typeof args.account === 'string' ? args.account : null,
            tool: tool.name,
            args,
            startedAt,
            error,
          });
          return { content: [{ type: 'text' as const, text: formatToolError(error) }], isError: true };
        }
      },
    );
  }
  return registered;
}
