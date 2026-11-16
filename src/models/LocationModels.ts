import mongoose, { Schema } from 'mongoose';

/** Safe zone for one patient. Only the active primary caregiver (with location authority) may write it. */
const SafeZoneSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    setBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lat: { type: Number, required: true }, lon: { type: Number, required: true }, radiusM: { type: Number, required: true },
}, { timestamps: true });
export const SafeZone = mongoose.model('SafeZone', SafeZoneSchema);

const fixShape = { lat: Number, lon: Number, accuracyM: Number, recordedAt: Number };

/** Latest patient fix plus boundary state. `rev` supports compare-and-set under concurrent fixes. */
const PatientLocationStateSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, required: true, unique: true },
    lastFix: fixShape,
    boundary: { armed: { type: Boolean, default: true }, outsideSince: Number, outsideCount: { type: Number, default: 0 } },
    rev: { type: Number, default: 0 },
}, { timestamps: true });
export const PatientLocationState = mongoose.model('PatientLocationState', PatientLocationStateSchema);

const CaregiverFixSchema = new Schema({
    caregiverId: { type: Schema.Types.ObjectId, required: true, unique: true },
    fix: fixShape,
}, { timestamps: true });
export const CaregiverFix = mongoose.model('CaregiverFix', CaregiverFixSchema);

const NearbyStateSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, required: true },
    caregiverId: { type: Schema.Types.ObjectId, required: true },
    notifiedAt: Number, rearmed: { type: Boolean, default: true }, rev: { type: Number, default: 0 },
});
NearbyStateSchema.index({ patientId: 1, caregiverId: 1 }, { unique: true, name: 'nearby_pair' });
export const NearbyStateModel = mongoose.model('NearbyState', NearbyStateSchema);

/** Push token registry (FCM). Token is overwritten by owner so a handed-over phone never notifies the old user. */
const DeviceTokenSchema = new Schema({
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, default: 'android' },
}, { timestamps: true });
DeviceTokenSchema.index({ userId: 1 });
export const DeviceToken = mongoose.model('DeviceToken', DeviceTokenSchema);
