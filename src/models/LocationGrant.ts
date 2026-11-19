import mongoose, { Schema, Document } from 'mongoose';

/**
 * Explicit, separate permission from the patient to one caregiver for location features.
 * Caregiver linking (including legacy/seeded links) never implies this. Disabled unless
 * LOCATION_FEATURE_ENABLED === 'true'. Guardian approval is not implemented.
 */
export interface ILocationGrant extends Document {
    patientId: mongoose.Types.ObjectId;
    caregiverId: mongoose.Types.ObjectId;
    status: 'active' | 'revoked';
    grantedAt: Date;
    revokedAt?: Date;
}

const LocationGrantSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    caregiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    grantedAt: { type: Date, default: Date.now },
    revokedAt: Date,
}, { timestamps: true });

LocationGrantSchema.index({ patientId: 1 });
LocationGrantSchema.index({ patientId: 1, caregiverId: 1 }, { name: 'one_active_grant_per_pair', unique: true, partialFilterExpression: { status: 'active' } });

export default mongoose.model<ILocationGrant>('LocationGrant', LocationGrantSchema);
