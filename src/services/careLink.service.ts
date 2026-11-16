import CareLink from '../models/CareLink';
import User from '../models/User';
import LocationGrant from '../models/LocationGrant';

export class LinkError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

const isId = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const isDup = (e: any) => e && (e.code === 11000 || e.code === 'DUP');
const OPEN: any = { $in: ['pending', 'active'] };

/**
 * Seeded/legacy links exist only as caregiver.linkedPatientIds. Give each an active
 * CareLink (role secondary, legacy=true) so the patient can see and revoke it.
 * Idempotent; never creates access that did not already exist.
 */
export async function adoptLegacyLinks(patient: any) {
    const caregivers: any[] = await User.find({ role: 'caregiver', linkedPatientIds: patient._id }).select('_id');
    for (const c of caregivers) {
        const open = await CareLink.findOne({ patientId: patient._id, caregiverId: c._id, status: OPEN });
        if (open) continue;
        try {
            await CareLink.create({ patientId: patient._id, caregiverId: c._id, status: 'active', role: 'secondary', legacy: true });
        } catch (e) { if (!isDup(e)) throw e; }
    }
}

/** Caregiver asks to link. Never reveals whether the email belongs to a patient. */
export async function requestLink(caregiver: any, email: unknown) {
    if (caregiver.role !== 'caregiver') throw new LinkError(403, 'Only caregivers can request a link');
    if (typeof email !== 'string' || !email.includes('@')) throw new LinkError(400, 'Valid patient email required');
    const patient: any = await User.findOne({ email: email.trim().toLowerCase(), role: 'patient' });
    if (patient) {
        const existing = await CareLink.findOne({ patientId: patient._id, caregiverId: caregiver._id, status: OPEN });
        const legacy = (caregiver.linkedPatientIds || []).some((p: any) => String(p) === String(patient._id));
        if (!existing && !legacy) {
            try { await CareLink.create({ patientId: patient._id, caregiverId: caregiver._id, status: 'pending' }); }
            catch (e) { if (!isDup(e)) throw e; }
        }
    }
    return { message: 'If a matching patient account exists, it now has a pending request. Access starts only after the patient approves.' };
}

/** Patient sees requests and active caregivers. Names only, no emails. */
export async function listIncoming(patient: any) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only patients can view requests');
    await adoptLegacyLinks(patient);
    const links: any[] = await CareLink.find({ patientId: patient._id, status: OPEN });
    const caregivers: any[] = await User.find({ _id: { $in: links.map(l => l.caregiverId) } }).select('name');
    const names = new Map(caregivers.map(c => [String(c._id), c.name]));
    return links.map(l => ({
        id: String(l._id), caregiverName: names.get(String(l.caregiverId)) ?? 'Unknown',
        role: l.role, status: l.status, legacy: !!l.legacy,
    }));
}

/** Caregiver sees their own requests/links. Names of patients only once active. */
export async function listOutgoing(caregiver: any) {
    if (caregiver.role !== 'caregiver') throw new LinkError(403, 'Only caregivers can view their requests');
    const links: any[] = await CareLink.find({ caregiverId: caregiver._id, status: OPEN });
    return links.map(l => ({ id: String(l._id), status: l.status, role: l.role }));
}

async function syncAccess(link: any) {
    // linkedPatientIds is a cache of "has an active link". Recompute from the link records,
    // then re-check once so a concurrent approve/revoke cannot leave the cache stale.
    for (let i = 0; i < 2; i++) {
        const active = await CareLink.findOne({ patientId: link.patientId, caregiverId: link.caregiverId, status: 'active' });
        if (active) await User.updateOne({ _id: link.caregiverId }, { $addToSet: { linkedPatientIds: link.patientId } });
        else await User.updateOne({ _id: link.caregiverId }, { $pull: { linkedPatientIds: link.patientId } });
    }
}

/** Patient decides. Approving is the only path that grants caregiver access. */
export async function respond(patient: any, linkId: unknown, approve: boolean, role?: unknown) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only the patient can respond');
    if (!isId(linkId)) throw new LinkError(400, 'Invalid link id');
    const set: any = { status: approve ? 'active' : 'declined', respondedAt: new Date() };
    if (approve && (role === 'primary' || role === 'secondary')) set.role = role;
    let link: any;
    try {
        // Atomic: only one of concurrent approve/decline/revoke can take a pending link.
        link = await CareLink.findOneAndUpdate({ _id: linkId, patientId: patient._id, status: 'pending' } as any, { $set: set }, { returnDocument: 'after' });
    } catch (e) {
        if (isDup(e)) throw new LinkError(409, 'This patient already has an active primary caregiver');
        throw e;
    }
    if (!link) throw new LinkError(404, 'No pending request');
    await syncAccess(link);
    return approve ? { status: link.status, role: link.role } : { status: link.status };
}

/** Either side can end the link. Access is removed immediately. */
export async function revoke(actor: any, linkId: unknown) {
    if (!isId(linkId)) throw new LinkError(400, 'Invalid link id');
    const owner = actor.role === 'patient' ? { patientId: actor._id } : { caregiverId: actor._id };
    const link: any = await CareLink.findOneAndUpdate(
        { _id: linkId, ...owner, status: OPEN } as any,
        { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: actor._id } }, { returnDocument: 'after' });
    if (!link) throw new LinkError(404, 'No such link');
    await syncAccess(link);
    // Ending a link also ends any location permission, so re-linking later starts from zero.
    await LocationGrant.updateMany({ patientId: link.patientId, caregiverId: link.caregiverId, status: 'active' } as any,
        { $set: { status: 'revoked', revokedAt: new Date() } });
    const { onAccessEnded } = await import('./location.service');
    await onAccessEnded(link.patientId, link.caregiverId);
    return { status: 'revoked' };
}
