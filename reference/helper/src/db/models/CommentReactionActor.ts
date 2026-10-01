import mongoose, { Schema } from 'mongoose';
import type { ICommentReactionActor } from '../../types/index.js';

const CommentReactionActorSchema = new Schema<ICommentReactionActor>({
  // identity: (группа, комментарий, актор)
  discussionChatId: { type: Number, required: true },
  messageId: { type: Number, required: true },
  actor: {
    id: { type: Number, required: true },
    type: { type: String, enum: ['user', 'channel', 'group_anonymous'], required: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    title: { type: String, default: null },
    isBot: { type: Boolean, default: false },
  },

  isOwner: { type: Boolean, default: false },
  reactions: { type: [String], default: [] },

  firstSeenAt: { type: Date, required: true },
  updatedAt: { type: Date, default: Date.now },
});

// identity: одна строка на (группа, комментарий, актор) — цель upsert'а
CommentReactionActorSchema.index(
  { discussionChatId: 1, messageId: 1, 'actor.id': 1, 'actor.type': 1 },
  { unique: true }
);
// «все реакции конкретного актора» (владелец, ядро аудитории)
CommentReactionActorSchema.index({ 'actor.id': 1, 'actor.type': 1 });
// Отдельный индекс {discussionChatId, messageId} не нужен: он строгий префикс
// unique-индекса выше и дал бы только write-амплификацию.

const CommentReactionActor = mongoose.model('CommentReactionActor', CommentReactionActorSchema);
export default CommentReactionActor;
