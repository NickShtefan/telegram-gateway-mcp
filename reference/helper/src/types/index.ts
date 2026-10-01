import type { Document, Types } from 'mongoose';

// ─── Telegram Bot API types (supplements @types/node-telegram-bot-api) ───

export interface ReactionType {
  // фактические wire-значения: 'emoji' | 'custom_emoji' | 'paid';
  // 'custom_emoji_id' — историческая опечатка, оставлена для старых данных
  type: 'emoji' | 'custom_emoji' | 'custom_emoji_id' | 'paid';
  emoji?: string;
  custom_emoji_id?: string;
}

export interface ReactionCountUpdate {
  message_id: number;
  chat: {
    id: number;
    type: string;
    username?: string;
    title?: string;
  };
  date: number;
  reactions: Array<{
    type: ReactionType;
    total_count: number;
  }>;
}

/** Update message_reaction (Bot API 7.0): по-пользовательский дифф реакций. */
export interface MessageReactionUpdate {
  chat: {
    id: number;
    type: string;
    username?: string;
    title?: string;
  };
  message_id: number;
  user?: { id: number; is_bot: boolean; username?: string; first_name?: string; last_name?: string };
  actor_chat?: { id: number; title?: string; username?: string; type?: string };
  date: number;
  old_reaction: ReactionType[];
  new_reaction: ReactionType[];
}

/** forward_origin (Bot API 7.0) — для автофорварда из канала type='channel'. */
export interface ForwardOrigin {
  type: string;
  chat?: { id: number; username?: string; title?: string };
  message_id?: number;
  date?: number;
}

/**
 * Поля Message, которых нет в @types/node-telegram-bot-api 0.64 (runtime 0.66
 * их отдаёт). Используется интерсекцией: `msg as Message & MessageExtraFields`.
 */
export interface MessageExtraFields {
  is_automatic_forward?: boolean;
  forward_origin?: ForwardOrigin;
  message_thread_id?: number;
  sender_chat?: { id: number; type?: string; title?: string; username?: string };
}

// ─── Media types ───

export interface MediaItem {
  fileId: string;
  fileType: 'photo' | 'video' | 'animation' | 'gif'
    // типы ниже встречаются в комментариях и хранятся только как метаданные
    | 'document' | 'audio' | 'voice' | 'video_note' | 'sticker';
  caption: string;
  filename: string;
  filePath?: string;
  media_group_id?: string | null;
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  downloaded?: boolean;
}

// ─── Mongoose model types ───

export interface IReaction {
  reaction: string;
  count: number;
}

// ─── Comment types (см. docs/comments-collection-design.md §4) ───

export type CommentAuthorType = 'user' | 'channel' | 'group_anonymous';

export interface ICommentAuthor {
  /** user id, либо sender_chat id для channel/group_anonymous */
  id: number | null;
  type: CommentAuthorType;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  /** название чата для type='channel' | 'group_anonymous' */
  title: string | null;
  isBot: boolean;
}

export interface IComment {
  // identity
  /** id группы обсуждений в Bot API-форме (-100…) — единственная каноническая форма в базе */
  discussionChatId: number;
  /** id сообщения внутри группы обсуждений */
  messageId: number;

  // linkage
  /** username канала (как Post.channelId); null у сироты до резолва */
  channelId: string | null;
  /** Post.telegramId; null, пока маппинг корня не резолвлен */
  postTelegramId: number | null;
  /** id корня-автофорварда В ГРУППЕ (= message_thread_id) */
  threadRootId: number;
  /** id комментария-родителя; null = верхний уровень */
  parentCommentId: number | null;

  author: ICommentAuthor;

  text: string;
  entities: unknown[];
  media: MediaItem[];

  /** у комментариев нет views, поэтому реакции лежат плоско, без обёртки stats */
  reactions: IReaction[];

  date: Date;
  editedAt: Date | null;
  /** tombstone: комментарий удалён в Telegram; hard-delete не делаем */
  deletedAt: Date | null;
  /** штамп последней сверки воркером (расписание живёт на Post.discussion) */
  lastSyncedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface ICommentDocument extends IComment, Document {
  _id: Types.ObjectId;
}

/**
 * Текущее состояние реакций одного актора на один комментарий (issue #86).
 * НЕ событийный лог: строка заменяется целиком при каждом message_reaction.
 * Снятая реакция оставляет строку с reactions: [] (tombstone-философия архива:
 * факт «этот актор реагировал» + firstSeenAt сохраняются).
 * Покрытие заведомо частичное: анонимные реакции и пропущенные апдейты акторов
 * не идентифицируют — агрегаты Comment.reactions остаются источником истины.
 */
export interface ICommentReactionActor {
  discussionChatId: number;      // Bot API форма (-100…)
  messageId: number;             // id комментария в группе
  actor: {
    id: number;
    type: CommentAuthorType;     // user | channel | group_anonymous
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    isBot: boolean;
  };
  /** владелец канала: личный аккаунт (me.id юзербота / CHANNEL_OWNER_USER_ID) либо реакция «как канал» */
  isOwner: boolean;
  /** текущие реакции актора, ключи через reactionKey(); [] = реакции сняты */
  reactions: string[];
  firstSeenAt: Date;
  updatedAt: Date;
}

/**
 * pending — корень треда ещё не резолвлен (очередь бэкфилла);
 * linked  — корень известен, тред обновляется (в т.ч. при 0 комментариев);
 * none    — комментарии недоступны (выключены / пост старше привязки группы) — терминально;
 * gone    — корень удалён, тред tombstone'ится — терминально.
 */
export type DiscussionState = 'pending' | 'linked' | 'none' | 'gone';

export interface IPostDiscussion {
  /** id группы обсуждений (Bot API-форма); фиксируется на посте при резолве */
  chatId: number | null;
  /** id корня-автофорварда в группе */
  rootMessageId: number | null;
  state: DiscussionState;
  /** кэш message.replies.replies с поста канала */
  commentsCount: number;
  resolveAttempts: number;
  lastCommentsRefreshedAt: Date | null;
  nextCommentsRefreshAt: Date | null;
}

export interface IStats {
  views: number;
  reactions: IReaction[];
  lastRefreshedAt: Date | null;
}

export interface IPost {
  telegramId: number;
  channelId: string;
  text: string;
  entities: unknown[];
  media: MediaItem[];
  stats: IStats;
  ownReaction: string | null;
  date: Date;
  nextRefreshAt: Date | null;
  discussion: IPostDiscussion;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPostDocument extends IPost, Document {
  _id: Types.ObjectId;
}

// ─── Config types ───

export interface TelegramConfig {
  telegram: {
    botToken: string | undefined;
    channelName: string;
    reactionEmojis: string[];
  };
  comments: {
    /** COMMENTS_ENABLED: единый kill switch фичи комментариев */
    enabled: boolean;
    /** COMMENTS_DOWNLOAD_MEDIA: качать ли файлы медиа комментариев (метаданные — всегда) */
    downloadMedia: boolean;
  };
}

// ─── GramJS types (for historical import) ───

export interface GramJSReactionResult {
  reaction: {
    emoticon?: string;
    [key: string]: unknown;
  };
  count: number;
}

export interface GramJSReactions {
  results: GramJSReactionResult[];
}

export interface GramJSMessage {
  id: number;
  message: string;
  date: number;
  views?: number;
  entities?: unknown[];
  reactions?: GramJSReactions;
  media?: unknown;
  chat?: {
    username?: string;
    title?: string;
  };
}

export interface GramJSClient {
  downloadMedia(media: unknown): Promise<Buffer | Uint8Array>;
  iterMessages(channel: string, opts: { limit: number; chunkSize: number; minId?: number }): AsyncIterable<GramJSMessage>;
}
