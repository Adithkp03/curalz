import CareLink from '../models/CareLink';
import User from '../models/User';

export class LinkError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

const isId = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

/** Caregiver asks to link. Never reveals whether the email belongs to a patient. */
export async function requestLink(caregiver: any, email: unknown) {
    if (caregiver.role !== 'caregiver') throw new LinkError(403, 'Only caregivers can request a link');
    if (typeof email !== 'string' || !email.includes('@')) throw new LinkError(400, 'Valid patient email required');
    const patient: any = await User.findOne({ email: email.trim().toLowerCase(), role: 'patient' });
    if (patient) {
        const existing: any = await CareLink.findOne({
            patientId: patient._id, caregiverId: caregiver._id, status: { $in: ['pending', 'active'] },
        });
        if (!existing) await CareLink.create({ patientId: patient._id, caregiverId: caregiver._id, status: 'pending' });
    }
    return { message: 'If a matching patient account exists, it now has a pending request. Access starts only after the patient approves.' };
}

/** Patient sees requests addressed to them. Only name is exposed, no email. */
export async function listIncoming(patient: any) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only patients can view requests');
    const links: any[] = await CareLink.find({ patientId: patient._id, status: { $in: ['pending', 'active'] } });
    const caregivers: any[] = await User.find({ _id: { $in: links.map(l => l.caregiverId) } }).select('name');
    const names = new Map(caregivers.map(c => [String(c._id), c.name]));
    return links.map(l => ({ id: String(l._id), caregiverName: names.get(String(l.caregiverId)) ?? 'Unknown', role: l.role, status: l.status }));
}

/** Patient decides. Approving is the only path that grants caregiver access. */
export async function respond(patient: any, linkId: unknown, approve: boolean, role?: unknown) {
    if (patient.role !== 'patient') throw new LinkError(403, 'Only the patient can respond');
    if (!isId(linkId)) throw new LinkError(400, 'Invalid link id');
    const link: any = await CareLink.findOne({ _id: linkId as any, patientId: patient._id });
    if (!link || link.status !== 'pending') throw new LinkError(404, 'No pending request');
    link.respondedAt = new Date();
    if (!approve) {
        link.status = 'declined';
        await link.save();
        return { status: link.status };
    }
    link.status = 'active';
    if (role === 'primary' || role === 'secondary') link.role = role;
    await link.save();
    await User.updateOne({ _id: link.caregiverId }, { $addToSet: { linkedPatientIds: link.patientId } });
    return { status: link.status, role: link.role };
}

/** Either side can end the link. Access is removed immediately. */
export async function revoke(actor: any, linkId: unknown) {
    if (!isId(linkId)) throw new LinkError(400, 'Invalid link id');
    const filter: any = actor.role === 'patient'
        ? { _id: linkId, patientId: actor._id } : { _id: linkId, caregiverId: actor._id };
    const link: any = await CareLink.findOne({ ...filter, status: { $in: ['pending', 'active'] } });
    if (!link) throw new LinkError(404, 'No such link');
    link.status = 'revoked';
    link.revokedAt = new Date();
    link.revokedBy = actor._id;
    await link.save();
    await User.updateOne({ _id: link.caregiverId }, { $pull: { linkedPatientIds: link.patientId } });
    return { status: 'revoked' };
}
