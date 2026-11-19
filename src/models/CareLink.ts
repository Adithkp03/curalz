import mongoose, { Schema, Document } from 'mongoose';

export type CareLinkStatus = 'pending' | 'active' | 'declined' | 'revoked';
export type CareLinkRole = 'primary' | 'secondary';

export interface ICareLink extends Document {
    patientId: mongoose.Types.ObjectId;
    caregiverId: mongoose.Types.ObjectId;
    role: CareLinkRole;
    status: CareLinkStatus;
    legacy?: boolean;
    respondedAt?: Date;
    revokedAt?: Date;
    revokedBy?: mongoose.Types.ObjectId;
}

const CareLinkSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    caregiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['primary', 'secondary'], default: 'secondary' },
    status: { type: String, enum: ['pending', 'active', 'declined', 'revoked'], default: 'pending' },
    legacy: { type: Boolean, default: false },
    respondedAt: Date,
    revokedAt: Date,
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// One open (pending/active) link per patient-caregiver pair, even under concurrent requests.
CareLinkSchema.index({ patientId: 1 });
CareLinkSchema.index({ caregiverId: 1 });
CareLinkSchema.index({ patientId: 1, caregiverId: 1 }, {
    name: 'one_open_link_per_pair', unique: true, partialFilterExpression: { status: { $in: ['pending', 'active'] } },
});
// At most one active primary caregiver per patient.
CareLinkSchema.index({ patientId: 1 }, {
    name: 'one_active_primary_per_patient', unique: true, partialFilterExpression: { status: 'active', role: 'primary' },
});

export default mongoose.model<ICareLink>('CareLink', CareLinkSchema);
