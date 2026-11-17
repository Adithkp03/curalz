import mongoose from 'mongoose';
import {createHash} from 'node:crypto';
import CareLink from '../models/CareLink';
import LocationGrant from '../models/LocationGrant';
import { SafeZone, PatientLocationState, CaregiverFix, NearbyStateModel, DeviceToken, CaregiverSharing, Outbox, BatteryOptIn, LOCATION_RETENTION_SECONDS } from '../models/LocationModels';
import { LinkError } from './careLink.service';
import { hasLocationAuthority } from './locationAuthority.service';
import { PROPOSED_LOCATION_CONFIG, LocationConfig } from '../location/config';
import { batteryDispatchCheck, batteryOnAccessEnded } from './battery.service';
import { Fix, isValidFix, validateZone, stepBoundary, stepNearby } from '../location/evaluate';

export interface Notification { userId: string; kind: 'patient_left_zone' | 'caregiver_nearby' | 'care_link_request' | 'battery_low' | 'battery_clear'; title: string; body: string; data?: Record<string, string> }
/** Push sender is injected. Returns 'sent' only if the provider accepted the message; 'logged' if it only logged. */
export type Sender = (n: Notification) => Promise<'sent' | 'logged'>;

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
    const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
    if (blank(zone?.lat) || blank(zone?.lon) || blank(zone?.radiusM)) throw new LinkError(400, 'Invalid boundary');
    const z = { lat: Number(zone?.lat), lon: Number(zone?.lon), radiusM: Number(zone?.radiusM) };
    if (!validateZone(z, cfg)) throw new LinkError(400, 'Invalid boundary');
    await SafeZone.findOneAndUpdate({ patientId }, { $set: { ...z, setBy: actor._id }, $inc: { rev: 1 } }, { upsert: true, new: true });
    // A zone change invalidates any exit alert computed against the old zone.
    await Outbox.updateMany({ patientId, kind: 'patient_left_zone', status: 'queued' } as any, { $set: { status: 'cancelled', reason: 'zone changed' } });
    return z;
}

export async function getZone(actor: any, patientId: string) {
    oid(patientId);
    const allowed = String(actor._id) === String(patientId) || (actor.role === 'caregiver' && await hasLocationAuthority(actor._id, patientId));
    if (!allowed) throw new LinkError(403, 'Not allowed');
    const z: any = await SafeZone.findOne({ patientId });
    return z && !(z.lat === 0 && z.lon === 0) ? { lat: z.lat, lon: z.lon, radiusM: z.radiusM } : null;
}

async function authorizedCaregivers(patientId: unknown): Promise<string[]> {
    const grants: any[] = await LocationGrant.find({ patientId, status: 'active' } as any);
    const ok: string[] = [];
    for (const g of grants) if (await hasLocationAuthority(g.caregiverId, patientId)) ok.push(String(g.caregiverId));
    return ok;
}

/** A zone only counts while the caregiver who set it is still the active primary with location authority. */
async function validZone(patientId: any): Promise<any | null> {
    const z: any = await SafeZone.findOne({ patientId });
    if (!z || (z.lat === 0 && z.lon === 0)) return null;   // a 0,0 centre is a blank-form leftover, never a real boundary
    const primary = await CareLink.findOne({ patientId, caregiverId: z.setBy, status: 'active', role: 'primary' } as any);
    return primary && (await hasLocationAuthority(z.setBy, patientId)) ? z : null;
}

const enqueue = (n: Notification & { patientId: any; caregiverId?: any; zoneRev?: number; fixRecordedAt?: number }) =>
    Outbox.create({ ...n, status: 'queued' });

/** Durable intent is committed in the SAME patient-state update as disarming.
 * Deterministic per-recipient _id makes retries safe after an insert/clear crash.
 * Dispatch still rechecks current grant/link,zone revision,and freshness.
 */
export async function materializePendingExit(patientId:any) {
    const st:any=await PatientLocationState.findOne({patientId});const p=st?.pendingExit;if(!p)return;
    for(const userId of p.recipients){
        const id=createHash('sha256').update(`${p.id}:${userId}`).digest('hex').slice(0,24);
        await Outbox.updateOne({_id:new mongoose.Types.ObjectId(id)},{$setOnInsert:{userId,patientId,kind:'patient_left_zone',title:p.title,body:'Open the app to see their live location.',zoneRev:p.zoneRev,fixRecordedAt:p.fix.recordedAt,data:{patientId:String(patientId),lat:String(p.fix.lat),lon:String(p.fix.lon),accuracyM:String(p.fix.accuracyM),recordedAt:String(p.fix.recordedAt)},status:'queued',retryNoDevice:true,createdAt:new Date(p.createdAt)}},{upsert:true});
    }
    await PatientLocationState.updateOne({patientId,'pendingExit.id':p.id},{$unset:{pendingExit:1}});
}

/** Patient device reports a fix. Sharing is on only while at least one grant is active (patient opt-in, until turned off). */
export async function ingestPatientFix(patient: any, raw: any, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only the patient device reports patient location');
    const fix = cleanFix(raw);
    await materializePendingExit(patient._id);
    const caregivers = await authorizedCaregivers(patient._id);
    if (!caregivers.length) throw new LinkError(403, 'Location sharing is off');
    const zone = await validZone(patient._id);
    let alert = false, stored = false;
    for (let attempt = 0; attempt < 12 && !stored; attempt++) {
        const st: any = (await PatientLocationState.findOneAndUpdate({ patientId: patient._id }, { $setOnInsert: { patientId: patient._id } }, { upsert: true, new: true }))!;
        // Ignore out-of-order fixes older than the one we hold.
        if (st.lastFix?.recordedAt && fix.recordedAt < st.lastFix.recordedAt) return { stored: false, alert: false };
        let boundary = { armed: st.boundary.armed, outsideSince: st.boundary.outsideSince ?? undefined, outsideCount: st.boundary.outsideCount };
        alert = false;
        if (zone) { const r = stepBoundary(boundary, zone, fix, now, cfg); boundary = r.state as any; alert = r.alert; }
        const pendingExit=alert?{id:String(new mongoose.Types.ObjectId()),recipients:caregivers,zoneRev:zone.rev,fix,title:`${patient.name} is outside the safe area`,createdAt:now}:undefined;
        const won = await PatientLocationState.findOneAndUpdate({ patientId: patient._id, rev: st.rev } as any,
            { $set: { lastFix: fix, boundary, rev: st.rev + 1, ...(pendingExit?{pendingExit}:{}) } }, { new: true });
        stored = !!won;
    }
    if (!stored) throw new LinkError(409, 'Busy, retry');
    if (alert) await materializePendingExit(patient._id);
    await Promise.all(caregivers.map(c => nearbyCheck(patient, c, now, cfg)));
    return { stored: true, alert };
}

/** Caregiver reports a position for nearby alerts. Requires the caregiver's OWN opt-in. */
export async function ingestCaregiverFix(caregiver: any, raw: any, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (caregiver.role !== 'caregiver') throw new LinkError(403, 'Only a caregiver reports caregiver location');
    if (!(await CaregiverSharing.findOne({ caregiverId: caregiver._id, active: true }))) throw new LinkError(403, 'Your location sharing is off');
    const fix = cleanFix(raw);
    const cur: any = await CaregiverFix.findOne({ caregiverId: caregiver._id });
    if (cur?.fix?.recordedAt && fix.recordedAt < cur.fix.recordedAt) return { stored: false };
    await CaregiverFix.findOneAndUpdate({ caregiverId: caregiver._id }, { $set: { fix } }, { upsert: true });
    const grants: any[] = await LocationGrant.find({ caregiverId: caregiver._id, status: 'active' } as any);
    const User = (await import('../models/User')).default;
    for (const g of grants) {
        if (!(await hasLocationAuthority(caregiver._id, g.patientId))) continue;
        const patient: any = await User.findById(g.patientId);
        if (patient) await nearbyCheck(patient, String(caregiver._id), now, cfg);
    }
    return { stored: true };
}

export async function setCaregiverSharing(caregiver: any, on: boolean) {
    if (caregiver.role !== 'caregiver') throw new LinkError(403, 'Only a caregiver');
    await CaregiverSharing.findOneAndUpdate({ caregiverId: caregiver._id }, { $set: { active: on } }, { upsert: true });
    if (!on) {
        await CaregiverFix.deleteMany({ caregiverId: caregiver._id });
        await Outbox.updateMany({ caregiverId: caregiver._id, kind: 'caregiver_nearby', status: 'queued' } as any, { $set: { status: 'cancelled', reason: 'caregiver opted out' } });
    }
    return { sharing: on };
}

/** Called whenever a grant/link ends: drop queued work for that pair, and the stored position if nobody can see it any more. */
export async function onAccessEnded(patientId: any, caregiverId: any) {
    await batteryOnAccessEnded(patientId, caregiverId);
    await Outbox.updateMany({ patientId, status: 'queued', $or: [{ userId: caregiverId }, { caregiverId }] } as any, { $set: { status: 'cancelled', reason: 'access ended' } });
    if (!(await authorizedCaregivers(patientId)).length) {
        await PatientLocationState.deleteMany({ patientId });
        await NearbyStateModel.deleteMany({ patientId });
        await Outbox.updateMany({ patientId, status: 'queued' } as any, { $set: { status: 'cancelled', reason: 'sharing off' } });
    }
}

/** The patient is told a linked caregiver is nearby (needs patient grant AND the caregiver's own opt-in). One notice per visit. */
async function nearbyCheck(patient: any, caregiverId: string, now: number, cfg: LocationConfig) {
    if (!(await CaregiverSharing.findOne({ caregiverId, active: true }))) return;
    const [ps, cf]: any[] = await Promise.all([PatientLocationState.findOne({ patientId: patient._id }), CaregiverFix.findOne({ caregiverId })]);
    if (!ps?.lastFix || !cf?.fix) return;
    for (let attempt = 0; attempt < 12; attempt++) {
        const ns: any = await NearbyStateModel.findOneAndUpdate({ patientId: patient._id, caregiverId }, { $setOnInsert: { patientId: patient._id, caregiverId } }, { upsert: true, new: true });
        const r = stepNearby({ notifiedAt: ns.notifiedAt ?? undefined, rearmed: ns.rearmed }, ps.lastFix, cf.fix, now, cfg);
        const won = await NearbyStateModel.findOneAndUpdate({ _id: ns._id, rev: ns.rev } as any, { $set: { notifiedAt: r.state.notifiedAt, rearmed: r.state.rearmed, rev: ns.rev + 1 } });
        if (!won) continue;
        if (r.notify) {
            const User = (await import('../models/User')).default;
            const c: any = await User.findById(caregiverId);
            await enqueue({ userId: String(patient._id), patientId: patient._id, caregiverId, kind: 'caregiver_nearby',
                title: `${c?.name ?? 'Your caregiver'} is nearby`, body: 'Someone who looks after you is close by.', data: { caregiverId },
                fixRecordedAt: Math.min(ps.lastFix.recordedAt, cf.fix.recordedAt) } as any);
        }
        return;
    }
}

/**
 * Send queued notifications. Re-checks everything at send time, so opt-out, link/grant revoke, a zone change or an old
 * fix cancels the item instead of disclosing a stale position. Returns counts by final state.
 */
export async function dispatchPending(send: Sender, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    const out = { sent: 0, logged: 0, cancelled: 0, failed: 0 };
    const pending:any[]=await PatientLocationState.find({'pendingExit.id':{$exists:true}}).limit(100);
    for(const st of pending)await materializePendingExit(st.patientId);
    // Only a confirmed pre-send failure is automatically retryable. Ambiguous provider
    // failures are never replayed: the device may already have received them.
    await Outbox.updateMany({status:'failed',reason:'no registered device',retryNoDevice:true,fixRecordedAt:{$gte:now-cfg.maxFixAgeMs}},{$set:{status:'queued'}});
    const items: any[] = await Outbox.find({ status: 'queued' }).sort({ createdAt: 1 }).limit(200);
    for (const it of items) {
        const claimed = await Outbox.findOneAndUpdate({ _id: it._id, status: 'queued' } as any, { $set: { status: 'cancelled', reason: 'dispatching' } }); // claim: no double send
        if (!claimed) continue;
        const cancel = async (reason: string) => { await Outbox.updateOne({ _id: it._id }, { $set: { status: 'cancelled', reason } }); out.cancelled++; };
        if (now - new Date(it.createdAt).getTime() > LOCATION_RETENTION_SECONDS * 1000) { await cancel('past retention'); continue; }  // logical expiry, independent of the TTL sweep
        const maxAge = it.kind === 'caregiver_nearby' ? cfg.nearbyMaxFixAgeMs : it.kind === 'battery_low' ? cfg.batteryMaxAgeMs : cfg.maxFixAgeMs;
        if (it.kind !== 'care_link_request' && it.kind !== 'battery_clear' && now - it.fixRecordedAt > maxAge) { await cancel('fix too old at send time'); continue; }
        if (it.kind === 'care_link_request') {
            // Only tell the patient about a request that is still waiting for them.
            if (!(await CareLink.findOne({ patientId: it.patientId, caregiverId: it.caregiverId, status: 'pending' } as any))) { await cancel('request no longer pending'); continue; }
        } else if (it.kind === 'battery_low' || it.kind === 'battery_clear') {
            const why = await batteryDispatchCheck(it, now, cfg);
            if (why) { await cancel(why); continue; }
        } else if (it.kind === 'patient_left_zone') {
            const z = await validZone(it.patientId);
            if (!z || z.rev !== it.zoneRev) { await cancel('zone changed or gone'); continue; }
            if (!(await hasLocationAuthority(it.userId, it.patientId))) { await cancel('access ended'); continue; }
        } else {
            if (!(await hasLocationAuthority(it.caregiverId, it.patientId)) || !(await CaregiverSharing.findOne({ caregiverId: it.caregiverId, active: true }))) { await cancel('opt-in ended'); continue; }
        }
        try {
            const state = await send({ userId: String(it.userId), kind: it.kind, title: it.title, body: it.body, data: { ...Object.fromEntries(it.data ?? []), ...(it.kind === 'patient_left_zone' ? { eventId: String(it._id), recipientId: String(it.userId) } : {}) } });
            await Outbox.updateOne({ _id: it._id }, { $set: { status: state }, $unset:{reason:1} }); out[state]++;
        } catch (e: any) {
            // Distinguish "no device registered" (FCM never called) from a provider rejection; fixed strings only, never the error text.
            const m = String(e?.message ?? '');
            const reason = m === 'no registered device' ? 'no registered device' : m === 'FCM rejected' ? 'FCM rejected' : 'sender error';
            await Outbox.updateOne({ _id: it._id }, { $set: { status: 'failed', reason } }); out.failed++;
        }
    }
    return out;
}

/** Live position for an authorized caregiver. A stale, future-dated or missing fix returns no coordinates. */
export async function liveLocation(caregiver: any, patientId: string, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    oid(patientId);
    if (caregiver.role !== 'caregiver' || !(await hasLocationAuthority(caregiver._id, patientId))) throw new LinkError(403, 'Not allowed');
    const st: any = await PatientLocationState.findOne({ patientId });
    if (!st?.lastFix?.recordedAt) return { status: 'unknown' as const };
    const ageMs = now - st.lastFix.recordedAt;
    if (now - new Date((st as any).updatedAt).getTime() > LOCATION_RETENTION_SECONDS * 1000) return { status: 'unknown' as const };  // past retention: treated as deleted even before the TTL sweep
    if (ageMs > cfg.maxFixAgeMs || ageMs < -30_000) return { status: 'stale' as const, ageMs };
    const { lat, lon, accuracyM, recordedAt } = st.lastFix;
    return { status: 'live' as const, lat, lon, accuracyM, recordedAt, ageMs };
}

export async function registerDeviceToken(user: any, token: unknown, platform = 'android', boundaryAlertV1 = false) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new LinkError(400, 'Invalid token');
    await DeviceToken.findOneAndUpdate({ token }, { $set: { userId: user._id, platform, boundaryAlertV1: boundaryAlertV1 === true } }, { upsert: true });
    return { ok: true };
}

/** Remove this device's token, only if it belongs to the signed-in user (logout). */
export async function unregisterDeviceToken(user: any, token: unknown) {
    if (typeof token !== 'string') throw new LinkError(400, 'Invalid token');
    await DeviceToken.deleteOne({ token, userId: user._id });
    return { ok: true };
}

/** What the signed-in user can see about location sharing. Names only; no coordinates. */
export async function sharingStatus(user: any) {
    const User = (await import('../models/User')).default;
    if (user.role === 'patient') {
        const links: any[] = await CareLink.find({ patientId: user._id, status: 'active' } as any);
        const grants: any[] = await LocationGrant.find({ patientId: user._id, status: 'active' } as any);
        const on = new Set(grants.map(g => String(g.caregiverId)));
        const out = [];
        for (const l of links) {
            const c: any = await User.findById(l.caregiverId);
            out.push({ caregiverId: String(l.caregiverId), caregiverName: c?.name ?? 'Caregiver', role: l.role, sharing: on.has(String(l.caregiverId)) });
        }
        const bo: any = await BatteryOptIn.findOne({ patientId: user._id });
        return { role: 'patient', caregivers: out, batteryOn: !!bo?.active };
    }
    const mine: any = await CaregiverSharing.findOne({ caregiverId: user._id });
    const links: any[] = await CareLink.find({ caregiverId: user._id, status: 'active' } as any);
    const grants: any[] = await LocationGrant.find({ caregiverId: user._id, status: 'active' } as any);
    const on = new Set(grants.map(g => String(g.patientId)));
    const out = [];
    for (const l of links) {
        const p: any = await User.findById(l.patientId);
        const sharing = on.has(String(l.patientId));
        const bo: any = l.role === 'primary' ? await BatteryOptIn.findOne({ patientId: l.patientId }) : null;
        out.push({ patientId: String(l.patientId), patientName: p?.name ?? 'Patient', role: l.role, patientSharing: sharing, canSetBoundary: l.role === 'primary' && sharing, batteryShared: !!bo?.active });
    }
    return { role: 'caregiver', mySharing: !!mine?.active, patients: out };
}

/** A push is only a hint. Re-check current recipient, grant, zone revision and event age before display. */
export async function boundaryAlertForCaregiver(actor: any, eventId: string, now = Date.now()) {
    oid(eventId);
    if (actor.role !== 'caregiver') throw new LinkError(403, 'Not allowed');
    const event: any = await Outbox.findOne({ _id: eventId, userId: actor._id, kind: 'patient_left_zone' });
    if (!event || now - new Date(event.createdAt).getTime() > PROPOSED_LOCATION_CONFIG.maxFixAgeMs || now - event.fixRecordedAt > PROPOSED_LOCATION_CONFIG.maxFixAgeMs)
        throw new LinkError(404, 'Alert is no longer current');
    if (!(await hasLocationAuthority(actor._id, event.patientId))) throw new LinkError(403, 'Not allowed');
    const zone = await validZone(event.patientId);
    if (!zone || zone.rev !== event.zoneRev) throw new LinkError(404, 'Alert is no longer current');
    return { eventId: String(event._id), patientId: String(event.patientId), recipientId: String(actor._id), occurredAt: new Date(event.createdAt).getTime() };
}
