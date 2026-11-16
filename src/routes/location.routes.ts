import express, { Response } from 'express';
import { protect } from '../middleware/auth.middleware';
import { LinkError } from '../services/careLink.service';
import { grantLocation, revokeLocation } from '../services/locationAuthority.service';
import { setZone, getZone, ingestPatientFix, ingestCaregiverFix, liveLocation, registerDeviceToken, Notifier } from '../services/location.service';
import LocationGrant from '../models/LocationGrant';
import { locationFeatureEnabled } from '../location/config';

/** Notifier is injected: the default only logs a count (no coordinates) until FCM is configured. */
export const makeLocationRouter = (notify: Notifier = async n => { console.log(`[location] notification ${n.kind} queued (no sender configured)`); }) => {
    const router = express.Router();
    router.use((_req, res, next) => locationFeatureEnabled() ? next() : res.status(404).json({ error: 'Not found' }));
    router.use(protect);
    const run = (fn: (req: any) => Promise<unknown>) => async (req: any, res: Response) => {
        try { res.json(await fn(req)); }
        catch (e: any) {
            if (e instanceof LinkError) return res.status(e.status).json({ error: e.message });
            res.status(500).json({ error: 'Request failed' });
        }
    };
    router.post('/grants', run(req => grantLocation(req.user, req.body?.caregiverId)));            // patient turns sharing on for a caregiver
    router.post('/grants/revoke', run(req => revokeLocation(req.user, req.body?.patientId, req.body?.caregiverId)));
    router.post('/sharing/off', run(async req => {                                                  // patient turns all sharing off
        if (req.user.role !== 'patient') throw new LinkError(403, 'Only the patient');
        await LocationGrant.updateMany({ patientId: req.user._id, status: 'active' } as any, { $set: { status: 'revoked', revokedAt: new Date() } });
        return { status: 'off' };
    }));
    router.put('/zone/:patientId', run(req => setZone(req.user, req.params.patientId, req.body)));
    router.get('/zone/:patientId', run(req => getZone(req.user, req.params.patientId)));
    router.post('/fix', run(req => req.user.role === 'patient' ? ingestPatientFix(req.user, req.body, notify) : ingestCaregiverFix(req.user, req.body, notify)));
    router.get('/live/:patientId', run(req => liveLocation(req.user, req.params.patientId)));
    router.post('/device-token', run(req => registerDeviceToken(req.user, req.body?.token)));
    return router;
};
