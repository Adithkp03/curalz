import { locationFeatureEnabled } from '../location/config';
import { makeFcmSender } from '../location/fcmSender';
import { dispatchPending } from '../services/location.service';
import { logOnlySender } from './location.routes';
import CareLink from '../models/CareLink';
import User from '../models/User';
import express, { Response } from 'express';
import { protect } from '../middleware/auth.middleware';
import { requestLink, listIncoming, listOutgoing, respond, revoke, LinkError } from '../services/careLink.service';

const router = express.Router();
router.use(protect);

const run = (fn: (req: any) => Promise<unknown>) => async (req: any, res: Response) => {
    try { res.json(await fn(req)); }
    catch (e: any) {
        if (e instanceof LinkError) return res.status(e.status).json({ error: e.message });
        res.status(500).json({ error: 'Request failed' });
    }
};

router.post('/request', run(async req => {
    const r = await requestLink(req.user, req.body?.email);
    if (locationFeatureEnabled()) await dispatchPending(makeFcmSender() ?? logOnlySender).catch(() => undefined); // inline: no background worker on serverless
    return r;
}));
router.get('/outgoing', run(req => listOutgoing(req.user)));
router.get('/incoming', run(req => listIncoming(req.user)));
router.post('/:id/approve', run(req => respond(req.user, req.params.id, true, req.body?.role)));
router.post('/:id/decline', run(req => respond(req.user, req.params.id, false)));
router.post('/:id/revoke', run(req => revoke(req.user, req.params.id)));

/** Canonical list for caregiver screens: patients with an ACTIVE, patient-approved link. Names only; no email or other profile data. */
export const caregiverPatientsRouter = express.Router();
caregiverPatientsRouter.get('/patients', protect, async (req: any, res: Response) => {
    try {
        if (req.user.role !== 'caregiver') return res.status(403).json({ error: 'Only caregivers can access this' });
        const links: any[] = await CareLink.find({ caregiverId: req.user._id, status: 'active' } as any);
        const users: any[] = await User.find({ _id: { $in: links.map(l => l.patientId) } }).select('name role');
        res.json({ patients: users.map(u => ({ _id: String(u._id), id: String(u._id), name: u.name, role: u.role, email: '' })) });
    } catch { res.status(500).json({ error: 'Request failed' }); }
});

export default router;
