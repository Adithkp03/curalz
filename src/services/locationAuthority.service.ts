import CareLink from '../models/CareLink';
import LocationGrant from '../models/LocationGrant';
import { LinkError } from './careLink.service';

const isDup = (e: any) => e && (e.code === 11000 || e.code === 'DUP');

/** Patient explicitly allows one linked caregiver to use location features. */
export async function grantLocation(patient: any, caregiverId: string) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only the patient can grant location access');
    const link = await CareLink.findOne({ patientId: patient._id, caregiverId, status: 'active' });
    if (!link) throw new LinkError(404, 'No active caregiver link');
    try { await LocationGrant.create({ patientId: patient._id, caregiverId, status: 'active' }); }
    catch (e) { if (!isDup(e)) throw e; }
    return { status: 'active' };
}

export async function revokeLocation(actor: any, patientId: string, caregiverId: string) {
    const ok = (actor.role === 'patient' && String(actor._id) === String(patientId)) ||
        (actor.role === 'caregiver' && String(actor._id) === String(caregiverId));
    if (!ok) throw new LinkError(403, 'Not allowed');
    await LocationGrant.findOneAndUpdate({ patientId, caregiverId, status: 'active' } as any, { $set: { status: 'revoked', revokedAt: new Date() } });
    const { onAccessEnded } = await import('./location.service');
    await onAccessEnded(patientId, caregiverId);
    return { status: 'revoked' };
}

/** The only check location code may use: an active link AND an active explicit grant. */
export async function hasLocationAuthority(caregiverId: unknown, patientId: unknown): Promise<boolean> {
    const [link, grant] = await Promise.all([
        CareLink.findOne({ patientId, caregiverId, status: 'active' } as any),
        LocationGrant.findOne({ patientId, caregiverId, status: 'active' } as any),
    ]);
    return !!(link && grant);
}
