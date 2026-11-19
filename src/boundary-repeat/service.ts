import mongoose, { Schema } from 'mongoose';
import { timingSafeEqual } from 'node:crypto';
import CareLink from '../models/CareLink';
import LocationGrant from '../models/LocationGrant';
import { DeviceToken, SafeZone, PatientLocationState } from '../models/LocationModels';
import { hasLocationAuthority } from '../services/locationAuthority.service';
import { LinkError } from '../services/careLink.service';
import { isValidFix, classify, distanceM, Fix, Zone } from '../location/evaluate';
import { PROPOSED_LOCATION_CONFIG, LocationConfig } from '../location/config';
import { makeFcmSender, CareSender } from '../location/fcmSender';
import { due, Policy, Episode as PolicyEpisode, Evidence } from './policy';

/**
 * Boundary-crossing repeat reminders (user request 2026-11-18 10:07 IST: repeat every 10 minutes
 * until the caregiver stops it). Owner-settled policies (2026-11-19 IST):
 *  - Stop silences only the caregiver who pressed it, for that crossing only.
 *  - A fresh, clearly-inside fix closes the crossing automatically.
 *  - While location is stale/unavailable, reminders continue and carry the last-seen-outside
 *    position snapshot and its timestamp; they never claim the patient is currently outside.
 * The first alert stays immediate via the existing outbox flow; this module only owns repeats.
 */
export const REPEAT_POLICY: Policy = { stopScope: 'caregiver', stale: 'unresolved_reminder', stopOnReturn: true };

const fixShape = { lat: Number, lon: Number, accuracyM: Number, recordedAt: Number };

const episodeSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, required: true },
    alertId: { type: String, required: true, unique: true },   // the pendingExit id that opened it
    zoneRev: { type: Number, required: true },
    openedAt: { type: Number, required: true },                // server ms of the first alert
    openedFix: fixShape,                                       // confirmed outside fix that opened it
    lastOutsideFix: fixShape,                                  // latest fresh outside fix while open
    lastFreshFix: fixShape,                                    // latest fresh valid fix of any kind
    open: { type: Boolean, default: true },
    closed: { type: String, enum: ['returned', 'zone_changed', 'sharing_ended'] },
    closedAt: Number,
    rev: { type: Number, default: 0 },
}, { timestamps: true });
// One open episode per patient. Coordinates live here only while the crossing is unresolved;
// 24h after closure the whole episode (including the last-seen snapshot) expires.
episodeSchema.index({ patientId: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'one_open_episode_per_patient' });
episodeSchema.index({ open: 1 });
episodeSchema.index({ closedAt: 1 }, { expireAfterSeconds: 86400, name: 'ttl_closed_episode' });
export const BoundaryEpisode = mongoose.model('BoundaryEpisode', episodeSchema);

const repeatStateSchema = new Schema({
    episodeId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    caregiverId: { type: Schema.Types.ObjectId, required: true },
    linkId: { type: Schema.Types.ObjectId, required: true },   // reminders live only while THIS link and grant stay active
    grantId: { type: Schema.Types.ObjectId, required: true },
    lastAttemptAt: Number,                                     // undefined => episode.openedAt (first repeat due openedAt+10min)
    stoppedAt: Number,                                         // this caregiver only, this crossing only
    rev: { type: Number, default: 0 },
}, { timestamps: true });
repeatStateSchema.index({ episodeId: 1, caregiverId: 1 }, { unique: true, name: 'one_repeat_state_per_caregiver' });
export const BoundaryRepeatState = mongoose.model('BoundaryRepeatState', repeatStateSchema);

const repeatEventSchema = new Schema({
    episodeId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },   // recipient caregiver
    patientId: { type: Schema.Types.ObjectId, required: true },
    attemptId: { type: String, required: true, unique: true },
    occurredAt: { type: Number, required: true },
    kind: { type: String, enum: ['outside_reminder', 'unresolved_reminder'], required: true },
    lastSeen: { type: fixShape, default: null },               // outside_reminder: current fix; unresolved: last outside fix
    status: { type: String, enum: ['pending', 'processing', 'sent', 'logged', 'failed', 'cancelled'], default: 'pending' },
    reason: String,
}, { timestamps: true });
repeatEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400, name: 'ttl_repeat_event' });
export const BoundaryRepeatEvent = mongoose.model('BoundaryRepeatEvent', repeatEventSchema);

export const repeatEnabled = (env: Record<string, string | undefined> = process.env) =>
    env.LOCATION_TEST_MODE === 'true' && env.LOCATION_FEATURE_ENABLED === 'true' && env.BOUNDARY_REPEAT_ENABLED === 'true';
export const repeatSchedulerActive = () => repeatEnabled() && process.env.BOUNDARY_REPEAT_SCHEDULER_ACTIVE === 'true';
export function repeatCronAuthorized(header: unknown) {
    const key = process.env.BOUNDARY_REPEAT_CRON_SECRET;
    if (!repeatEnabled() || !key || key.length < 32 || typeof header !== 'string') return false;
    const a = Buffer.from(header), b = Buffer.from('Bearer ' + key);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Same rule as location.service's validZone: the zone counts only while its setter stays an authorized active primary. */
async function currentZone(patientId: any): Promise<any | null> {
    const z: any = await SafeZone.findOne({ patientId });
    if (!z || (z.lat === 0 && z.lon === 0)) return null;
    const primary = await CareLink.findOne({ patientId, caregiverId: z.setBy, status: 'active', role: 'primary' } as any);
    return primary && (await hasLocationAuthority(z.setBy, patientId)) ? z : null;
}

const currentAccess = async (s: any) =>
    !!(await CareLink.exists({ _id: s.linkId, patientId: s.patientId, caregiverId: s.caregiverId, status: 'active' } as any) &&
        await LocationGrant.exists({ _id: s.grantId, patientId: s.patientId, caregiverId: s.caregiverId, status: 'active' } as any));

async function closeEpisode(ep: any, reason: 'returned' | 'zone_changed' | 'sharing_ended', now: number) {
    const won = await BoundaryEpisode.findOneAndUpdate({ _id: ep._id, open: true } as any,
        { $set: { open: false, closed: reason, closedAt: now }, $inc: { rev: 1 } }, { new: true });
    if (!won) return false;
    await BoundaryRepeatState.deleteMany({ episodeId: ep._id } as any);
    await BoundaryRepeatEvent.updateMany({ episodeId: ep._id, status: { $in: ['pending', 'processing'] } } as any,
        { $set: { status: 'cancelled', reason: 'episode ' + reason } });
    return true;
}

/** The confirmed first alert opens the crossing episode. Idempotent per alert and per patient. */
export async function openEpisode(patientId: any, zoneRev: number, fix: Fix, recipients: string[], alertId: string, now: number) {
    if (!repeatEnabled()) return;
    let ep: any;
    try {
        ep = await BoundaryEpisode.create({ patientId, alertId, zoneRev, openedAt: now, openedFix: fix, lastOutsideFix: fix, lastFreshFix: fix, open: true, rev: 0 });
    } catch (e: any) {
        if (e?.code !== 11000) throw e;   // concurrent open or a duplicate alert id: use the existing open episode
        ep = await BoundaryEpisode.findOne({ patientId, open: true } as any);
    }
    if (!ep) return;
    for (const caregiverId of recipients) {
        const [link, grant] = await Promise.all([
            CareLink.findOne({ patientId, caregiverId, status: 'active' } as any),
            LocationGrant.findOne({ patientId, caregiverId, status: 'active' } as any),
        ]);
        if (!link || !grant) continue;   // no reminder stream without live consent at open time
        try {
            await BoundaryRepeatState.updateOne({ episodeId: ep._id, caregiverId } as any,
                { $setOnInsert: { episodeId: ep._id, patientId, caregiverId, linkId: link._id, grantId: grant._id, rev: 0 } }, { upsert: true });
        } catch (e: any) { if (e?.code !== 11000) throw e; }
    }
}

/**
 * Every stored patient fix feeds the open episode: keeps the last-seen snapshots current and closes
 * the crossing on a fresh clearly-inside fix (same hysteresis as the detector's re-arm) or a zone change.
 */
export async function noteEpisodeFix(patientId: any, fix: Fix, zone: Zone & { rev?: number } | null, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (!repeatEnabled()) return;
    for (let attempt = 0; attempt < 12; attempt++) {
        const ep: any = await BoundaryEpisode.findOne({ patientId, open: true } as any);
        if (!ep) return;
        if (!zone || zone.rev !== ep.zoneRev) { await closeEpisode(ep, 'zone_changed', now); return; }
        const fresh = isValidFix(fix) && fix.recordedAt <= now + 30_000 && now - fix.recordedAt <= cfg.maxFixAgeMs;
        const pos = fresh ? classify(zone, fix, now, cfg) : 'unknown';
        const clearlyInside = pos === 'inside' && distanceM(zone, fix) + fix.accuracyM <= zone.radiusM * cfg.reenterMarginRatio;
        if (clearlyInside) { await closeEpisode(ep, 'returned', now); return; }
        const set: any = {};
        if (fresh) set.lastFreshFix = fix;
        if (pos === 'outside') set.lastOutsideFix = fix;
        if (!Object.keys(set).length) return;
        const won = await BoundaryEpisode.findOneAndUpdate({ _id: ep._id, rev: ep.rev } as any, { $set: set, $inc: { rev: 1 } });
        if (won) return;
    }
}

/** A zone rewrite invalidates crossings judged against the old zone. */
export async function repeatZoneChanged(patientId: any, currentZoneRev: number, now = Date.now()) {
    if (!repeatEnabled()) return;
    const ep: any = await BoundaryEpisode.findOne({ patientId, open: true } as any);
    if (ep && ep.zoneRev !== currentZoneRev) await closeEpisode(ep, 'zone_changed', now);
}

/** Grant/link ended: that caregiver's reminders stop; with nobody left to remind the crossing closes. */
export async function repeatAccessEnded(patientId: any, caregiverId: any, now = Date.now()) {
    if (!repeatEnabled()) return;
    const ep: any = await BoundaryEpisode.findOne({ patientId, open: true } as any);
    if (!ep) return;
    await BoundaryRepeatState.deleteMany({ episodeId: ep._id, caregiverId } as any);
    await BoundaryRepeatEvent.updateMany({ episodeId: ep._id, userId: caregiverId, status: { $in: ['pending', 'processing'] } } as any,
        { $set: { status: 'cancelled', reason: 'access ended' } });
    if (!(await BoundaryRepeatState.exists({ episodeId: ep._id } as any))) await closeEpisode(ep, 'sharing_ended', now);
}

/** The caregiver's own Stop. Durable, idempotent, scoped to this caregiver and this crossing. */
export async function stopRepeat(actor: any, episodeId: string, now = Date.now()) {
    if (!repeatEnabled() || actor.role !== 'caregiver' || !mongoose.isValidObjectId(episodeId)) throw new LinkError(404, 'Alert unavailable');
    const ep: any = await BoundaryEpisode.findById(episodeId);
    if (!ep) throw new LinkError(404, 'Alert unavailable');
    const state: any = await BoundaryRepeatState.findOne({ episodeId: ep._id, caregiverId: actor._id } as any);
    if (!state) throw new LinkError(404, 'Alert unavailable');
    if (!(await hasLocationAuthority(actor._id, ep.patientId))) throw new LinkError(403, 'Not allowed');
    if (state.stoppedAt === undefined)
        await BoundaryRepeatState.findOneAndUpdate({ _id: state._id, rev: state.rev } as any, { $set: { stoppedAt: now }, $inc: { rev: 1 } });
    return { episodeId: String(ep._id), stopped: true, closed: ep.closed ?? null };
}

/** What the app shows after a repeat push: re-validated live, never the push payload alone. */
export async function readRepeatEvent(actor: any, id: string) {
    if (!repeatEnabled() || actor.role !== 'caregiver' || !mongoose.isValidObjectId(id)) throw new LinkError(404, 'Alert unavailable');
    const e: any = await BoundaryRepeatEvent.findOne({ _id: id, userId: actor._id, status: { $in: ['processing', 'sent'] } } as any);
    if (!e) throw new LinkError(404, 'Alert unavailable');
    const ep: any = await BoundaryEpisode.findOne({ _id: e.episodeId, open: true } as any);
    if (!ep) throw new LinkError(404, 'Alert is no longer current');
    if (!(await hasLocationAuthority(actor._id, e.patientId))) throw new LinkError(403, 'Not allowed');
    const state: any = await BoundaryRepeatState.findOne({ episodeId: ep._id, caregiverId: actor._id } as any);
    if (!state) throw new LinkError(404, 'Alert is no longer current');
    const seen = e.lastSeen && isValidFix(e.lastSeen) ? { lat: e.lastSeen.lat, lon: e.lastSeen.lon, accuracyM: e.lastSeen.accuracyM, recordedAt: e.lastSeen.recordedAt } : null;
    return {
        eventId: String(e._id), episodeId: String(ep._id), patientId: String(e.patientId), recipientId: String(actor._id),
        occurredAt: e.occurredAt, kind: e.kind, lastSeen: seen, openedAt: ep.openedAt,
        stopped: state.stoppedAt !== undefined, schedulerActive: repeatSchedulerActive(),
    };
}

const toPolicyEpisode = (ep: any, s: any): PolicyEpisode => ({
    id: String(ep._id), openedAt: ep.openedAt,
    stoppedBy: s.stoppedAt !== undefined ? [String(s.caregiverId)] : [],
    lastAttemptAt: s.lastAttemptAt !== undefined ? { [String(s.caregiverId)]: s.lastAttemptAt } : {},
});

/**
 * Minute sweep (Cloudflare cron). Sends at most one repeat per caregiver per 10 minutes, schedules
 * late sweeps from now (never a catch-up burst), claims the attempt atomically BEFORE the provider so
 * an ambiguous provider failure is skipped rather than replayed, and re-checks consent, link, grant,
 * zone revision and episode openness at send time.
 */
export async function sweepRepeats(send: CareSender | null = makeFcmSender(), now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (!repeatEnabled()) return { enabled: false };
    await Promise.all([BoundaryEpisode, BoundaryRepeatState, BoundaryRepeatEvent].map(m => m.init()));
    const result = { enabled: true, checked: 0, closed: 0, waiting: 0, waitingForDevice: 0, sent: 0, logged: 0, failed: 0, cancelled: 0 };
    const episodes: any[] = await BoundaryEpisode.find({ open: true } as any).limit(1001);
    if (episodes.length > 1000) throw Error('Repeat sweep batch limit');
    for (const ep of episodes) {
        result.checked++;
        const z = await currentZone(ep.patientId);
        if (!z || z.rev !== ep.zoneRev) { if (await closeEpisode(ep, 'zone_changed', now)) result.closed++; continue; }
        const st: any = await PatientLocationState.findOne({ patientId: ep.patientId });
        const lf = st?.lastFix;
        const fresh = isValidFix(lf) && lf.recordedAt <= now + 30_000 && now - lf.recordedAt <= cfg.maxFixAgeMs;
        const pos = fresh ? classify(z, lf, now, cfg) : 'unknown';
        const clearlyInside = pos === 'inside' && distanceM(z, lf) + lf.accuracyM <= z.radiusM * cfg.reenterMarginRatio;
        if (clearlyInside) { if (await closeEpisode(ep, 'returned', now)) result.closed++; continue; }
        if (pos === 'outside') await BoundaryEpisode.updateOne({ _id: ep._id } as any, { $set: { lastOutsideFix: lf, lastFreshFix: lf }, $inc: { rev: 1 } });
        const states: any[] = await BoundaryRepeatState.find({ episodeId: ep._id } as any).limit(101);
        for (const s of states) {
            if (s.stoppedAt !== undefined) continue;
            if (!(await currentAccess(s))) {
                await BoundaryRepeatState.deleteOne({ _id: s._id } as any);
                await BoundaryRepeatEvent.updateMany({ episodeId: ep._id, userId: s.caregiverId, status: { $in: ['pending', 'processing'] } } as any,
                    { $set: { status: 'cancelled', reason: 'access ended' } });
                result.cancelled++;
                continue;
            }
            const evidence: Evidence = { currentAccess: true, sameOriginalLinkAndGrant: true, sameZone: true, fresh, clearlyInside, outside: pos === 'outside' };
            const decision = due(toPolicyEpisode(ep, s), String(s.caregiverId), evidence, REPEAT_POLICY, now);
            if (decision === 'wait') { result.waiting++; continue; }
            if (decision === 'suppressed') continue;
            if (!send || !(await DeviceToken.exists({ userId: s.caregiverId, boundaryRepeatV1: true } as any))) { result.waitingForDevice++; continue; }
            // Claim before the provider attempt: a crash or ambiguous failure skips this slot.
            const won = await BoundaryRepeatState.findOneAndUpdate({ _id: s._id, rev: s.rev } as any, { $set: { lastAttemptAt: now }, $inc: { rev: 1 } }, { new: true });
            if (!won) continue;
            const _id = new mongoose.Types.ObjectId();
            const lastSeen = decision === 'outside_reminder' ? { lat: lf.lat, lon: lf.lon, accuracyM: lf.accuracyM, recordedAt: lf.recordedAt }
                : (ep.lastOutsideFix ?? ep.openedFix);
            await BoundaryRepeatEvent.create({ _id, episodeId: ep._id, userId: s.caregiverId, patientId: ep.patientId, attemptId: String(_id), occurredAt: now, kind: decision, lastSeen, status: 'processing' });
            // Revalidate after the atomic claim.
            if (!(await BoundaryEpisode.exists({ _id: ep._id, open: true } as any)) || !(await currentAccess(s))) {
                await BoundaryRepeatEvent.updateOne({ _id }, { $set: { status: 'cancelled', reason: 'no longer current' } });
                result.cancelled++;
                continue;
            }
            const patient: any = await (await import('../models/User')).default.findById(ep.patientId);
            const name = patient?.name ?? 'The patient';
            const title = decision === 'outside_reminder' ? `${name} is still outside the safe area` : 'Boundary alert still unresolved';
            const body = decision === 'outside_reminder'
                ? 'Open AlzheFi to see their current location.'
                : 'Last seen outside before location updates stopped. Open AlzheFi for where and when.';
            try {
                const state = await send({ userId: String(s.caregiverId), kind: 'boundary_repeat', title, body,
                    data: { patientId: String(ep.patientId), eventId: String(_id), episodeId: String(ep._id) } });
                await BoundaryRepeatEvent.updateOne({ _id }, { $set: { status: state } });
                if (state === 'sent') result.sent++; else result.logged++;
            } catch {
                await BoundaryRepeatEvent.updateOne({ _id }, { $set: { status: 'failed', reason: 'provider attempt did not complete' } });
                result.failed++;
            }
        }
    }
    return result;
}
