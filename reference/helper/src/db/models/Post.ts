import mongoose, { Schema } from 'mongoose';
import type { IPost } from '../../types/index.js';

const PostSchema = new Schema<IPost>({
  telegramId: { type: Number, required: true, unique: true },
  channelId: { type: String, required: true },
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
  stats: {
    views: { type: Number, default: 0 },
    reactions: {
      type: [{
        reaction: { type: String, required: true },
        count: { type: Number, required: true, default: 0 }
      }],
      default: []
    },
    lastRefreshedAt: { type: Date, default: null }
  },
  ownReaction: { type: String, default: null },
  date: { type: Date, required: true },
  nextRefreshAt: { type: Date, default: (): Date => new Date(), index: true },
  // Состояние треда комментариев в группе обсуждений
  // (docs/comments-collection-design.md §4.3). У новых постов state='pending' и
  // nextCommentsRefreshAt=now, чтобы CommentsRefresher резолвил корень треда.
  discussion: {
    chatId: { type: Number, default: null },
    rootMessageId: { type: Number, default: null },
    state: { type: String, enum: ['pending', 'linked', 'none', 'gone'], default: 'pending' },
    commentsCount: { type: Number, default: 0 },
    resolveAttempts: { type: Number, default: 0 },
    lastCommentsRefreshedAt: { type: Date, default: null },
    nextCommentsRefreshAt: { type: Date, default: (): Date => new Date() },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// realtime: маппинг входящего комментария (message_thread_id) -> пост
PostSchema.index({ 'discussion.chatId': 1, 'discussion.rootMessageId': 1 });
// очередь CommentsRefresher (зеркало паттерна nextRefreshAt)
PostSchema.index({ 'discussion.nextCommentsRefreshAt': 1 });
// очередь бэкфилла: только нерезолвленные посты (partial — после резолва строк мало)
PostSchema.index(
  { 'discussion.state': 1 },
  { partialFilterExpression: { 'discussion.state': 'pending' }, name: 'discussion_pending' }
);

const Post = mongoose.model('Post', PostSchema);
export default Post;
