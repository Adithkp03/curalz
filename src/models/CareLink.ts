import mongoose, { Schema, Document } from 'mongoose';

export type CareLinkStatus = 'pending' | 'active' | 'declined' | 'revoked';
export type CareLinkRole = 'primary' | 'secondary';

export interface ICareLink extends Document {
    patientId: mongoose.Types.ObjectId;
    caregiverId: mongoose.Types.ObjectId;
    role: CareLinkRole;
    status: CareLinkStatus;
    respondedAt?: Date;
    revokedAt?: Date;
    revokedBy?: mongoose.Types.ObjectId;
}

const CareLinkSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    caregiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['primary', 'secondary'], default: 'secondary' },
    status: { type: String, enum: ['pending', 'active', 'declined', 'revoked'], default: 'pending' },
    respondedAt: Date,
    revokedAt: Date,
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export default mongoose.model<ICareLink>('CareLink', CareLinkSchema);
