import express, { Response } from 'express';
import { protect } from '../middleware/auth.middleware';
import { classify } from '../location/evaluate';
import { PROPOSED_LOCATION_CONFIG as cfg } from '../location/config';
import { LinkError } from '../services/careLink.service';
import { grantLocation, revokeLocation } from '../services/locationAuthority.service';
import { boundaryAlertForCaregiver, setZone, getZone, ingestPatientFix, ingestCaregiverFix, liveLocation, registerDeviceToken, unregisterDeviceToken, setCaregiverSharing, sharingStatus, onAccessEnded, dispatchPending, Sender } from '../services/location.service';
import { setBatteryOptIn, ingestBattery, batteryForCaregiver } from '../services/battery.service';
import LocationGrant from '../models/LocationGrant';
import { locationFeatureEnabled } from '../location/config';
import { fcmDiagnostic } from '../location/fcmSender';
import { DeviceToken, SafeZone, PatientLocationState, Outbox } from '../models/LocationModels';

/** Default sender only LOGS a kind (no coordinates, no push); its items end as 'logged', never 'sent'. */
export const logOnlySender: Sender = async n => { console.log(`[location] ${n.kind} logged (no push sender configured)`); return 'logged'; };
export const makeLocationRouter = (send: Sender = logOnlySender) => {
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
    // Test host only: the caller's OWN notification rows (kind, state, reason, time). No coordinates, no other users.
    router.get('/diagnostics/outbox', run(async req => {
        if (process.env.LOCATION_TEST_MODE !== 'true') throw new LinkError(404, 'Not found');
        const rows: any[] = await Outbox.find({ userId: req.user._id } as any).sort({ createdAt: -1 }).limit(20);
        return rows.map(r => ({ kind: r.kind, status: r.status, reason: r.reason ?? null, createdAt: r.createdAt }));
    }));
    // Diagnostics reveal no tokens or coordinates. Same authority check as live position.
    router.get('/diagnostics/device', run(async req => {
        if (process.env.LOCATION_TEST_MODE !== 'true') throw new LinkError(404, 'Not found');
        return { registeredDevices: await DeviceToken.countDocuments({ userId: req.user._id }) };
    }));
    router.get('/diagnostics/boundary/:patientId', run(async req => {
        if (process.env.LOCATION_TEST_MODE !== 'true') throw new LinkError(404, 'Not found');
        const live = await liveLocation(req.user, req.params.patientId); // validates id, role, active link and patient grant
        const [zone, state]: any[] = await Promise.all([SafeZone.findOne({ patientId: req.params.patientId }), PatientLocationState.findOne({ patientId: req.params.patientId })]);
        const position = zone && live.status === 'live' ? classify(zone, live, Date.now()) : 'unknown';
        return {
            position, hasZone: !!zone, armed: state?.boundary?.armed ?? true,
            outsideCount: state?.boundary?.outsideCount ?? 0,
            outsideSpanMs: state?.boundary?.outsideSince && state?.lastFix ? Math.max(0, state.lastFix.recordedAt - state.boundary.outsideSince) : 0,
            requiredFixes: cfg.exitConfirmFixes, requiredSpanMs: cfg.exitConfirmSpanMs, maxAccuracyM: cfg.maxAccuracyM,
        };
    }));
    router.get('/alerts/:eventId', run(req => boundaryAlertForCaregiver(req.user, req.params.eventId)));
    router.get('/status', run(req => sharingStatus(req.user)));
    // Test host only (fail closed): server-side FCM credential/API check, dry run to a fake token, no device, no delivery.
    router.get('/diagnostics/fcm', run(async () => { if (process.env.LOCATION_TEST_MODE !== 'true') throw new LinkError(404, 'Not found'); return fcmDiagnostic(); }));
    router.post('/grants', run(req => grantLocation(req.user, req.body?.caregiverId)));            // patient turns sharing on for a caregiver
    router.post('/grants/revoke', run(req => revokeLocation(req.user, req.user.role === 'patient' ? String(req.user._id) : req.body?.patientId, req.user.role === 'caregiver' ? String(req.user._id) : req.body?.caregiverId)));
    router.post('/sharing/off', run(async req => {                                                  // patient turns all sharing off
        if (req.user.role !== 'patient') throw new LinkError(403, 'Only the patient');
        const gs: any[] = await LocationGrant.find({ patientId: req.user._id, status: 'active' } as any);
        await LocationGrant.updateMany({ patientId: req.user._id, status: 'active' } as any, { $set: { status: 'revoked', revokedAt: new Date() } });
        for (const g of gs) await onAccessEnded(req.user._id, g.caregiverId);
        await setBatteryOptIn(req.user, false);   // "stop sharing with everyone" also ends battery sharing, deletes the reading, cancels queued alerts and sends the clear
        await dispatchPending(send).catch(() => undefined);
        return { status: 'off' };
    }));
    router.put('/zone/:patientId', run(req => setZone(req.user, req.params.patientId, req.body)));
    router.get('/zone/:patientId', run(req => getZone(req.user, req.params.patientId)));
    router.post('/fix', run(async req => {
        const r = req.user.role === 'patient' ? await ingestPatientFix(req.user, req.body) : await ingestCaregiverFix(req.user, req.body);
        await dispatchPending(send).catch(() => undefined); // inline dispatch (serverless has no background worker)
        return r;
    }));
    router.post('/battery/on', run(req => setBatteryOptIn(req.user, true)));
    router.post('/battery/off', run(async req => { const r = await setBatteryOptIn(req.user, false); await dispatchPending(send).catch(() => undefined); return r; }));
    router.post('/battery', run(async req => {
        const r = await ingestBattery(req.user, req.body);
        await dispatchPending(send).catch(() => undefined);
        return r;
    }));
    router.get('/battery/:patientId', run(req => batteryForCaregiver(req.user, req.params.patientId)));
    router.post('/caregiver-sharing/on', run(req => setCaregiverSharing(req.user, true)));
    router.post('/caregiver-sharing/off', run(req => setCaregiverSharing(req.user, false)));
    router.get('/live/:patientId', run(req => liveLocation(req.user, req.params.patientId)));
    router.post('/device-token', run(req => registerDeviceToken(req.user, req.body?.token, 'android', req.body?.boundaryAlertV1 === true)));
    router.post('/device-token/remove', run(req => unregisterDeviceToken(req.user, req.body?.token, 'android', req.body?.boundaryAlertV1 === true)));
    return router;
};
