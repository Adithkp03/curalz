import { DeviceToken } from '../models/LocationModels';
import type { Sender } from '../services/location.service';

/**
 * Real push sender (Firebase Cloud Messaging via firebase-admin). Not wired in by default: the app only uses it when
 * FIREBASE_SERVICE_ACCOUNT_JSON is present in the server env. Privacy: the push carries only the kind and patient id,
 * never coordinates; the app fetches the live position over the authenticated API (which refuses stale fixes).
 * Returns 'sent' only when FCM accepted the message for at least one registered device (that is acceptance,
 * not proof the phone received it). No registered device or FCM rejection throws, so the outbox row becomes 'failed'.
 */
// Literal specifier so the serverless bundler includes firebase-admin in the deployed function.
const loadAdmin = async (): Promise<any> => { const m: any = await import('firebase-admin'); return m.default ?? m; };

/**
 * Test-host diagnostic. Sends a dry-run (validate_only) FCM request to a deliberately fake token: nothing is delivered
 * and no device is involved. An 'invalid-argument' or 'registration-token-not-registered' answer means the credential
 * loaded, authenticated and the FCM API accepted the request path; auth or permission codes mean it did not.
 * It never returns the credential. It is not delivery proof.
 */
export const fcmDiagnostic = async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return { credentialPresent: false };
    let cred: any;
    try { cred = JSON.parse(raw); } catch { return { credentialPresent: true, credentialParses: false }; }
    const out: any = { credentialPresent: true, credentialParses: true, projectId: cred.project_id, clientEmail: cred.client_email };
    try {
        const admin = await loadAdmin();
        out.sdkLoaded = true;
        const app = admin.apps?.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(cred) });
        await admin.messaging(app).send({ token: 'diagnostic-not-a-real-token', data: { kind: 'diagnostic' } }, true);
        out.dryRun = 'accepted';
    } catch (e: any) { out.dryRun = String(e?.code ?? 'error'); }
    return out;
};

export const makeFcmSender = (): Sender | null => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let messaging: any;
    const init = async () => {
        if (messaging) return messaging;
        const admin: any = await loadAdmin();
        const app = admin.apps?.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
        messaging = admin.messaging(app);
        return messaging;
    };
    return async n => {
        const tokens = (await DeviceToken.find({ userId: n.userId } as any)).map((t: any) => t.token);
        if (!tokens.length) throw new Error('no registered device');
        const m = await init();
        const res = await m.sendEachForMulticast({
            tokens, notification: { title: n.title, body: n.body },
            data: { kind: n.kind, patientId: n.data?.patientId ?? '' },
            android: { priority: 'high' },
        });
        const bad = res.responses.map((r: any, i: number) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? tokens[i] : null)).filter(Boolean);
        if (bad.length) await DeviceToken.deleteMany({ token: { $in: bad } } as any);
        if (res.successCount < 1) throw new Error('FCM rejected');
        return 'sent';
    };
};
