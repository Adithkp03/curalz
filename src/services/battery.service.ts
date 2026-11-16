import mongoose from 'mongoose';
import CareLink from '../models/CareLink';
import { BatteryOptIn, PatientBattery, Outbox } from '../models/LocationModels';
import { LinkError } from './careLink.service';
import { PROPOSED_LOCATION_CONFIG, LocationConfig } from '../location/config';

/**
 * Battery alerts (test scope, not clinically validated).
 * - The patient's own switch (BatteryOptIn, off by default, separate from the location grant) is the only thing that lets
 *   a reading be stored or shown. Recipients: the patient's own phone and the ACTIVE PRIMARY caregiver. Not secondary.
 * - Alert: reading fresh, strictly below the threshold and not charging. One alert per low-battery episode. The episode
 *   ends when the phone is charging (or back at/above the threshold); then the next low reading starts a new one.
 * - Plugging in cancels queued alerts and sends a data-only "clear" so a shown alert can be removed. Not a follow-up message.
 * - Pushes carry only kind and patientId.
 */
const oid = (v: unknown) => { if (typeof v !== 'string' || !mongoose.isValidObjectId(v)) throw new LinkError(400, 'Invalid id'); return v; };

export async function primaryCaregiverId(patientId: any): Promise<string | null> {
    const l: any = await CareLink.findOne({ patientId, status: 'active', role: 'primary' } as any);
    return l ? String(l.caregiverId) : null;
}
const optedIn = async (patientId: any) => !!(await BatteryOptIn.findOne({ patientId, active: true }));

async function recipients(patientId: any): Promise<string[]> {
    const p = await primaryCaregiverId(patientId);
    return [String(patientId), ...(p ? [p] : [])];
}

/** Enqueue a data-only clear for the patient and primary, but only if an alert may be showing. */
async function clearShown(patientId: any) {
    await Outbox.updateMany({ patientId, kind: 'battery_low', status: 'queued' } as any, { $set: { status: 'cancelled', reason: 'charging or recovered' } });
    await clearShownNoState(patientId);
}

export async function setBatteryOptIn(patient: any, on: boolean) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only the patient');
    await BatteryOptIn.findOneAndUpdate({ patientId: patient._id }, { $set: { active: on } }, { upsert: true });
    if (!on) {
        await PatientBattery.deleteMany({ patientId: patient._id });
        await Outbox.updateMany({ patientId: patient._id, kind: 'battery_low', status: 'queued' } as any, { $set: { status: 'cancelled', reason: 'battery sharing off' } });
        await clearShownNoState(patient._id);
    }
    return { batteryOn: on };
}
async function clearShownNoState(patientId: any) {
    const shown = await Outbox.findOne({ patientId, kind: 'battery_low', status: { $in: ['sent', 'logged'] }, reason: { $ne: 'cleared' } } as any);
    if (!shown) return;
    for (const u of await recipients(patientId)) await Outbox.create({ userId: u, patientId, kind: 'battery_clear', title: '', body: '', data: { patientId: String(patientId) }, status: 'queued' } as any);
    await Outbox.updateMany({ patientId, kind: 'battery_low', status: { $in: ['sent', 'logged'] } } as any, { $set: { reason: 'cleared' } });
}

export async function ingestBattery(patient: any, raw: any, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only the patient device reports battery');
    if (!(await optedIn(patient._id))) throw new LinkError(403, 'Battery sharing is off');
    const pct = Number(raw?.pct), recordedAt = Number(raw?.recordedAt);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100 || typeof raw?.charging !== 'boolean' || !Number.isFinite(recordedAt) || recordedAt > now + 30_000 || recordedAt < now - cfg.batteryMaxAgeMs)
        throw new LinkError(400, 'Invalid battery reading');
    const rounded = Math.round(pct);
    const prev: any = await PatientBattery.findOne({ patientId: patient._id });
    if (prev?.recordedAt && recordedAt < prev.recordedAt) return { stored: false, alert: false };   // out of order
    await PatientBattery.findOneAndUpdate({ patientId: patient._id }, { $set: { pct: rounded, charging: raw.charging, recordedAt }, $setOnInsert: { patientId: patient._id } }, { upsert: true });
    const low = !raw.charging && rounded < cfg.batteryLowBelowPct;
    if (!low) {
        // Charging or recovered: close the episode (atomic) and remove any alert that may be showing.
        const closed = await PatientBattery.findOneAndUpdate({ patientId: patient._id, lowActive: true } as any, { $set: { lowActive: false } });
        if (closed || raw.charging) await clearShown(patient._id);
        return { stored: true, alert: false };
    }
    const opened = await PatientBattery.findOneAndUpdate({ patientId: patient._id, lowActive: { $ne: true } } as any, { $set: { lowActive: true } });
    if (!opened) return { stored: true, alert: false };   // episode already alerted
    const name = patient.name ?? 'The patient';
    for (const u of await recipients(patient._id)) {
        const own = u === String(patient._id);
        await Outbox.create({
            userId: u, patientId: patient._id, kind: 'battery_low', fixRecordedAt: recordedAt, status: 'queued',
            title: own ? 'Your phone battery is low' : `${name}'s phone battery is low`,
            body: own ? `Battery is below ${cfg.batteryLowBelowPct}%. Plug in your charger.` : `Battery is below ${cfg.batteryLowBelowPct}% and not charging.`,
            data: { patientId: String(patient._id) },
        } as any);
    }
    return { stored: true, alert: true };
}

/** Send-time re-check for battery items. Returns a cancel reason, or null to send. */
export async function batteryDispatchCheck(it: any, now: number, cfg: LocationConfig): Promise<string | null> {
    if (it.kind === 'battery_clear') {
        return (it.userId && (await recipients(it.patientId)).includes(String(it.userId))) ? null : 'recipient no longer linked';
    }
    if (!(await optedIn(it.patientId))) return 'battery sharing off';
    if (!(await recipients(it.patientId)).includes(String(it.userId))) return 'access ended';
    const b: any = await PatientBattery.findOne({ patientId: it.patientId });
    if (!b || !b.lowActive) return 'no longer low';
    if (b.charging) return 'charging';
    if (!(b.pct < cfg.batteryLowBelowPct)) return 'recovered';
    if (now - b.recordedAt > cfg.batteryMaxAgeMs) return 'reading too old at send time';
    return null;
}

export async function batteryOnAccessEnded(patientId: any, caregiverId: any) {
    await Outbox.updateMany({ patientId, userId: caregiverId, kind: { $in: ['battery_low', 'battery_clear'] }, status: 'queued' } as any, { $set: { status: 'cancelled', reason: 'access ended' } });
}

/** Primary caregiver (active link) sees the reading only while the patient's switch is on and the reading is fresh. */
export async function batteryForCaregiver(caregiver: any, patientId: string, now = Date.now(), cfg: LocationConfig = PROPOSED_LOCATION_CONFIG) {
    oid(patientId);
    if (caregiver.role !== 'caregiver') throw new LinkError(403, 'Not allowed');
    if ((await primaryCaregiverId(patientId)) !== String(caregiver._id)) throw new LinkError(403, 'Not allowed');
    if (!(await optedIn(patientId))) return { status: 'off' as const };
    const b: any = await PatientBattery.findOne({ patientId });
    if (!b?.recordedAt) return { status: 'unknown' as const };
    const ageMs = now - b.recordedAt;
    if (ageMs > cfg.batteryMaxAgeMs || ageMs < -30_000) return { status: 'stale' as const, ageMs };
    return { status: 'live' as const, pct: b.pct, charging: !!b.charging, ageMs };
}
