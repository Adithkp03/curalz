import mongoose from 'mongoose';
import CareLink from '../models/CareLink';
import LocationGrant from '../models/LocationGrant';
import { SafeZone, PatientLocationState, CaregiverFix, NearbyStateModel, DeviceToken } from '../models/LocationModels';
import { LinkError } from './careLink.service';
import { hasLocationAuthority } from './locationAuthority.service';
import { PROPOSED_LOCATION_CONFIG, LocationConfig } from '../location/config';
import { Fix, isValidFix, validateZone, stepBoundary, stepNearby } from '../location/evaluate';

export interface Notification { userId: string; kind: 'patient_left_zone' | 'caregiver_nearby'; title: string; body: string; data?: Record<string, string> }
/** Delivery is injected. Real FCM sender is separate and off unless configured; tests use a recorder. */
export type Notifier = (n: Notification) => Promise<void>;

const oid = (v: unknown) => {
    if (typeof v !== 'string' || !mongoose.isValidObjectId(v)) throw new LinkError(400, 'Invalid id');
    return v;
};
const cleanFix = (f: any): Fix => {
    const fix = { lat: Number(f?.lat), lon: Number(f?.lon), accuracyM: Number(f?.accuracyM), recordedAt: Number(f?.recordedAt) };
    if (!isValidFix(fix)) throw new LinkError(400, 'Invalid location fix');
    return fix;
};

/** Primary caregiver only (settled by the user 2026-11-16 12:09). Needs active primary link AND active patient grant. */
export async function setZone(actor: any, patientId: string, zone: any, cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (actor.role !== 'caregiver') throw new LinkError(403, 'Only a caregiver can set the boundary');
    oid(patientId);
    const primary = await CareLink.findOne({ patientId, caregiverId: actor._id, status: 'active', role: 'primary' } as any);
    if (!primary || !(await hasLocationAuthority(actor._id, patientId))) throw new LinkError(403, 'Only the primary caregiver with patient-approved location sharing can set the boundary');
    const z = { lat: Number(zone?.lat), lon: Number(zone?.lon), radiusM: Number(zone?.radiusM) };
    if (!validateZone(z, cfg)) throw new LinkError(400, 'Invalid boundary');
    await SafeZone.findOneAndUpdate({ patientId }, { $set: { ...z, setBy: actor._id } }, { upsert: true, new: true });
    return z;
}

export async function getZone(actor: any, patientId: string) {
    oid(patientId);
    const allowed = String(actor._id) === String(patientId) || (actor.role === 'caregiver' && await hasLocationAuthority(actor._id, patientId));
    if (!allowed) throw new LinkError(403, 'Not allowed');
    const z: any = await SafeZone.findOne({ patientId });
    return z ? { lat: z.lat, lon: z.lon, radiusM: z.radiusM } : null;
}

async function authorizedCaregivers(patientId: unknown): Promise<string[]> {
    const grants: any[] = await LocationGrant.find({ patientId, status: 'active' } as any);
    const ok: string[] = [];
    for (const g of grants) if (await hasLocationAuthority(g.caregiverId, patientId)) ok.push(String(g.caregiverId));
    return ok;
}

/** Patient device reports a fix. Sharing is on only while at least one grant is active (patient opt-in, until turned off). */
export async function ingestPatientFix(patient: any, raw: any, notify: Notifier, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only the patient device reports patient location');
    const fix = cleanFix(raw);
    const caregivers = await authorizedCaregivers(patient._id);
    if (!caregivers.length) throw new LinkError(403, 'Location sharing is off');
    const zone: any = await SafeZone.findOne({ patientId: patient._id });
    let alert = false;
    for (let attempt = 0; attempt < 5; attempt++) {
        const st: any = (await PatientLocationState.findOneAndUpdate({ patientId: patient._id }, { $setOnInsert: { patientId: patient._id } }, { upsert: true, new: true }))!;
        // Ignore out-of-order fixes older than the one we hold.
        if (st.lastFix?.recordedAt && fix.recordedAt < st.lastFix.recordedAt) return { stored: false, alert: false };
        let boundary = { armed: st.boundary.armed, outsideSince: st.boundary.outsideSince ?? undefined, outsideCount: st.boundary.outsideCount };
        alert = false;
        if (zone) { const r = stepBoundary(boundary, zone, fix, now, cfg); boundary = r.state as any; alert = r.alert; }
        const won = await PatientLocationState.findOneAndUpdate({ patientId: patient._id, rev: st.rev } as any,
            { $set: { lastFix: fix, boundary, rev: st.rev + 1 } }, { new: true });
        if (won) break;
        if (attempt === 4) throw new LinkError(409, 'Busy, retry');
    }
    if (alert) {
        // Primary and secondary caregivers who hold location authority both get the alert with the live position.
        await Promise.all(caregivers.map(c => notify({
            userId: c, kind: 'patient_left_zone', title: `${patient.name} is outside the safe area`,
            body: 'Open the app to see their live location.',
            data: { patientId: String(patient._id), lat: String(fix.lat), lon: String(fix.lon), accuracyM: String(fix.accuracyM), recordedAt: String(fix.recordedAt) },
        })));
    }
    await Promise.all(caregivers.map(c => nearbyCheck(patient, c, notify, now, cfg)));
    return { stored: true, alert };
}

export async function ingestCaregiverFix(caregiver: any, raw: any, notify: Notifier, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (caregiver.role !== 'caregiver') throw new LinkError(403, 'Only a caregiver reports caregiver location');
    const fix = cleanFix(raw);
    const cur: any = await CaregiverFix.findOne({ caregiverId: caregiver._id });
    if (cur?.fix?.recordedAt && fix.recordedAt < cur.fix.recordedAt) return { stored: false };
    await CaregiverFix.findOneAndUpdate({ caregiverId: caregiver._id }, { $set: { fix } }, { upsert: true });
    const grants: any[] = await LocationGrant.find({ caregiverId: caregiver._id, status: 'active' } as any);
    for (const g of grants) {
        if (!(await hasLocationAuthority(caregiver._id, g.patientId))) continue;
        const User = (await import('../models/User')).default;
        const patient: any = await User.findById(g.patientId);
        if (patient) await nearbyCheck(patient, String(caregiver._id), notify, now, cfg);
    }
    return { stored: true };
}

/** The patient is told a linked, sharing caregiver is nearby (patient-facing, one notice per visit). */
async function nearbyCheck(patient: any, caregiverId: string, notify: Notifier, now: number, cfg: LocationConfig) {
    const [ps, cf]: any[] = await Promise.all([PatientLocationState.findOne({ patientId: patient._id }), CaregiverFix.findOne({ caregiverId })]);
    if (!ps?.lastFix || !cf?.fix) return;
    for (let attempt = 0; attempt < 5; attempt++) {
        const ns: any = await NearbyStateModel.findOneAndUpdate({ patientId: patient._id, caregiverId }, { $setOnInsert: { patientId: patient._id, caregiverId } }, { upsert: true, new: true });
        const r = stepNearby({ notifiedAt: ns.notifiedAt ?? undefined, rearmed: ns.rearmed }, ps.lastFix, cf.fix, now, cfg);
        const won = await NearbyStateModel.findOneAndUpdate({ _id: ns._id, rev: ns.rev } as any, { $set: { notifiedAt: r.state.notifiedAt, rearmed: r.state.rearmed, rev: ns.rev + 1 } });
        if (!won) continue;
        if (r.notify) {
            const User = (await import('../models/User')).default;
            const c: any = await User.findById(caregiverId);
            await notify({ userId: String(patient._id), kind: 'caregiver_nearby', title: `${c?.name ?? 'Your caregiver'} is nearby`, body: 'Someone who looks after you is close by.', data: { caregiverId } });
        }
        return;
    }
}

/** Live position for an authorized caregiver (alert deep link target). Stale fixes are returned with their age so the UI can say so. */
export async function liveLocation(caregiver: any, patientId: string, now = Date.now()) {
    oid(patientId);
    if (caregiver.role !== 'caregiver' || !(await hasLocationAuthority(caregiver._id, patientId))) throw new LinkError(403, 'Not allowed');
    const st: any = await PatientLocationState.findOne({ patientId });
    if (!st?.lastFix) return null;
    return { ...st.lastFix.toObject?.() ?? st.lastFix, ageMs: now - st.lastFix.recordedAt };
}

export async function registerDeviceToken(user: any, token: unknown, platform = 'android') {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new LinkError(400, 'Invalid token');
    await DeviceToken.findOneAndUpdate({ token }, { $set: { userId: user._id, platform } }, { upsert: true });
    return { ok: true };
}
