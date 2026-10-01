import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IClientSession {
  clientId: Types.ObjectId;
  sessionString: string;
  iv: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IClientSessionDocument extends IClientSession, Document {
  _id: Types.ObjectId;
}

const ClientSessionSchema = new Schema<IClientSession>({
  clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
  sessionString: { type: String, required: true },
  iv: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ClientSessionSchema.pre('save', function () {
  this.updatedAt = new Date();
});

export default mongoose.model('ClientSession', ClientSessionSchema);
