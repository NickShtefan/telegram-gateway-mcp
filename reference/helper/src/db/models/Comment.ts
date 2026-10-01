import mongoose, { Schema } from 'mongoose';
import type { IComment } from '../../types/index.js';

const CommentSchema = new Schema<IComment>({
  // identity: id группы обсуждений (Bot API-форма -100…) + id сообщения в ней
  discussionChatId: { type: Number, required: true },
  messageId: { type: Number, required: true },

  // linkage: натуральные ключи, как везде в кодовой базе; nullable до резолва маппинга
  channelId: { type: String, default: null },
  postTelegramId: { type: Number, default: null },
  threadRootId: { type: Number, required: true },
  parentCommentId: { type: Number, default: null },

  author: {
    id: { type: Number, default: null },
    type: { type: String, enum: ['user', 'channel', 'group_anonymous'], required: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    title: { type: String, default: null },
    isBot: { type: Boolean, default: false },
  },

  text: { type: String, default: '' },
  entities: { type: [Schema.Types.Mixed], default: [] },
  media: [
    {
      fileId: String,
      fileType: String,
      caption: String,
      filename: String,
      filePath: String,
      media_group_id: { type: String, default: null },
      width: Number,
      height: Number,
      duration: Number,
      mime_type: String,
      downloaded: Boolean,
    }
  ],

  // у комментариев нет views — реакции плоско, без обёртки stats
  reactions: {
    type: [{
      reaction: { type: String, required: true },
      count: { type: Number, required: true, default: 0 }
    }],
    default: []
  },

  date: { type: Date, required: true },
  editedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  lastSyncedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// identity: одна строка на (группа, сообщение) — цель upsert'а всех писателей
CommentSchema.index({ discussionChatId: 1, messageId: 1 }, { unique: true });
// «все комментарии поста по порядку» — экспорт, пересчёт счётчика
CommentSchema.index({ channelId: 1, postTelegramId: 1, date: 1 });
// обход треда воркером: сверка сохранённых id с fetched для tombstone-диффа
CommentSchema.index({ discussionChatId: 1, threadRootId: 1, messageId: 1 });
// очередь сирот: комментарии без резолвленного поста
CommentSchema.index(
  { discussionChatId: 1, threadRootId: 1 },
  { partialFilterExpression: { postTelegramId: null }, name: 'orphan_postlink' }
);

const Comment = mongoose.model('Comment', CommentSchema);
export default Comment;
