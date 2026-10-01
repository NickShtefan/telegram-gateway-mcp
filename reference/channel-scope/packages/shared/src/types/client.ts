export interface Client {
  _id: string;
  name: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  status: 'active' | 'needs_auth' | 'awaiting_code' | 'awaiting_password' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface ClientEvent {
  clientId: string;
  status: string;
  message?: string;
}
