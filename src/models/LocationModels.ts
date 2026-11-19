import mongoose, { Schema } from 'mongoose';

/** PROPOSED minimal retention (not approved): stored positions and queued/sent alerts expire this long after their last update. */
export const LOCATION_RETENTION_SECONDS = Number(process.env.LOCATION_RETENTION_HOURS ?? 24) * 3600;

/** Safe zone for one patient. Only the active primary caregiver (with location authority) may write it. */
const SafeZoneSchema = new Schema({
    name: {type:String,maxlength:60}, isHome: {type:Boolean},
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    setBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lat: { type: Number, required: true }, lon: { type: Number, required: true }, radiusM: { type: Number, required: true },
    rev: { type: Number, default: 0 },
}, { timestamps: true });
export const SafeZone = mongoose.model('SafeZone', SafeZoneSchema);

const fixShape = { lat: Number, lon: Number, accuracyM: Number, recordedAt: Number };

/** Latest patient fix plus boundary state. `rev` supports compare-and-set under concurrent fixes. */
const PatientLocationStateSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, required: true, unique: true },
    lastFix: fixShape,
    pendingExit: Schema.Types.Mixed,
    boundary: { armed: { type: Boolean, default: true }, outsideSince: Number, outsideCount: { type: Number, default: 0 } },
    rev: { type: Number, default: 0 },
}, { timestamps: true });
PatientLocationStateSchema.index({ updatedAt: 1 }, { expireAfterSeconds: LOCATION_RETENTION_SECONDS, name: 'ttl_patient_position' });
export const PatientLocationState = mongoose.model('PatientLocationState', PatientLocationStateSchema);

const CaregiverFixSchema = new Schema({
    caregiverId: { type: Schema.Types.ObjectId, required: true, unique: true },
    fix: fixShape,
}, { timestamps: true });
CaregiverFixSchema.index({ updatedAt: 1 }, { expireAfterSeconds: LOCATION_RETENTION_SECONDS, name: 'ttl_caregiver_position' });
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
    locationHealthV1: {type:Boolean,default:false},
    boundaryAlertV1: { type: Boolean, default: false },
    boundaryRepeatV1: { type: Boolean, default: false },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, default: 'android' },
}, { timestamps: true });
DeviceTokenSchema.index({ userId: 1 });
export const DeviceToken = mongoose.model('DeviceToken', DeviceTokenSchema);

/** A caregiver's own explicit opt-in to share their position for nearby alerts. Separate from the patient's grant. */
const CaregiverSharingSchema = new Schema({
    caregiverId: { type: Schema.Types.ObjectId, required: true, unique: true },
    active: { type: Boolean, default: true },
}, { timestamps: true });
export const CaregiverSharing = mongoose.model('CaregiverSharing', CaregiverSharingSchema);

/**
 * Notification outbox. States: queued -> (cancelled | logged | sent | failed).
 * 'logged' = only written to the server log (no push configured). 'sent' = the push provider accepted it.
 * 'delivered' is deliberately not a state: only a device acknowledgement could prove it, and none exists yet.
 */
const OutboxSchema = new Schema({
    userId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['patient_left_zone', 'caregiver_nearby', 'care_link_request', 'battery_low', 'battery_clear'], required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    caregiverId: { type: Schema.Types.ObjectId },
    title: String, body: String,
    data: { type: Map, of: String },
    zoneRev: Number,
    fixRecordedAt: Number,
    status: { type: String, enum: ['queued', 'cancelled', 'logged', 'sent', 'failed'], default: 'queued' },
    reason: String,
    retryNoDevice: {type:Boolean,default:false},
}, { timestamps: true });
OutboxSchema.index({ status: 1, createdAt: 1 });
OutboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: LOCATION_RETENTION_SECONDS, name: 'ttl_outbox' });
export const Outbox = mongoose.model('Outbox', OutboxSchema);

/** The patient's OWN explicit switch for battery alerts. Separate from the location grant; off by default. */
const BatteryOptInSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, required: true, unique: true },
    active: { type: Boolean, default: true },
}, { timestamps: true });
export const BatteryOptIn = mongoose.model('BatteryOptIn', BatteryOptInSchema);

/** Latest battery reading + whether a low-battery episode is open. Expires like the position state. */
const PatientBatterySchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, required: true, unique: true },
    pct: Number, charging: Boolean, recordedAt: Number,
    lowActive: { type: Boolean, default: false },
    alertedSent: { type: Boolean, default: false },
}, { timestamps: true });
PatientBatterySchema.index({ updatedAt: 1 }, { expireAfterSeconds: LOCATION_RETENTION_SECONDS, name: 'ttl_patient_battery' });
export const PatientBattery = mongoose.model('PatientBattery', PatientBatterySchema);
