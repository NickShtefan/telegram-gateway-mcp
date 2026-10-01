import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IClient {
  name: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  status: 'active' | 'needs_auth' | 'awaiting_code' | 'awaiting_password' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

export interface IClientDocument extends IClient, Document {
  _id: Types.ObjectId;
}

const ClientSchema = new Schema<IClient>({
  name: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  apiId: { type: Number, required: true },
  apiHash: { type: String, required: true },
  status: {
    type: String,
    enum: ['active', 'needs_auth', 'awaiting_code', 'awaiting_password', 'disabled'],
    default: 'needs_auth',
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ClientSchema.pre('save', function () {
  this.updatedAt = new Date();
});

export default mongoose.model('Client', ClientSchema);
