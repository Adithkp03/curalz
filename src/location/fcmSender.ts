import { DeviceToken } from '../models/LocationModels';
import type { Sender,Notification } from '../services/location.service';

/**
 * Real push sender (Firebase Cloud Messaging via firebase-admin). Not wired in by default: the app only uses it when
 * FIREBASE_SERVICE_ACCOUNT_JSON is present in the server env. Privacy: the push carries only the kind and patient id,
 * never coordinates; the app fetches the live position over the authenticated API (which refuses stale fixes).
 * Returns 'sent' only when FCM accepted the message for at least one registered device (that is acceptance,
 * not proof the phone received it). No registered device or FCM rejection throws, so the outbox row becomes 'failed'.
 */
// Literal specifier so the serverless bundler includes firebase-admin in the deployed function.
const getMessagingFor = async (cred: any): Promise<any> => {
    const { initializeApp, getApps, getApp, cert }: any = await import('firebase-admin/app');
    const { getMessaging }: any = await import('firebase-admin/messaging');
    const app = getApps().length ? getApp() : initializeApp({ credential: cert(cred) });
    return getMessaging(app);
};

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
        const messaging = await getMessagingFor(cred);
        out.sdkLoaded = true;
        await messaging.send({ token: 'diagnostic-not-a-real-token', data: { kind: 'diagnostic' } }, true);
        out.dryRun = 'accepted';
    } catch (e: any) { out.dryRun = String(e?.code ?? e?.errorInfo?.code ?? 'error'); out.detail = String(e?.message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200); }
    return out;
};

export type CarePush=Omit<Notification,'kind'>&{kind:Notification['kind']|'medication_followup'};
export type CareSender=(n:CarePush)=>Promise<'sent'|'logged'>;
export const makeFcmSender = (): CareSender | null => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let messaging: any;
    const init = async () => {
        if (messaging) return messaging;
        messaging = await getMessagingFor(JSON.parse(raw));
        return messaging;
    };
    return async n => {
        const devices: any[] = await DeviceToken.find({ userId: n.userId } as any);
        const tokens = devices.map(t => t.token);
        if (!tokens.length) throw new Error('no registered device');
        const m = await init();
        const clear = n.kind === 'battery_clear';
        // Old APKs still receive a system notification. Only clients advertising
        // the new handler get data-only boundary events and create their own FSI.
        const res = await m.sendEach(devices.map(d => ({
            token: d.token,
            ...((clear || (n.kind === 'patient_left_zone' && d.boundaryAlertV1)) ? {} : { notification: { title: n.title, body: n.body } }),
            data: { kind: n.kind, patientId: n.data?.patientId ?? '', eventId: n.data?.eventId ?? '', recipientId: n.userId },
            android: { priority: 'high', ttl: 300000, ...(n.kind === 'battery_low' ? { notification: { tag: `battery-low-${n.data?.patientId ?? ''}` } } : {}) },
        })));
        const bad = res.responses.map((r: any, i: number) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? tokens[i] : null)).filter(Boolean);
        if (bad.length) await DeviceToken.deleteMany({ token: { $in: bad } } as any);
        if (res.successCount < 1) throw new Error('FCM rejected');
        return 'sent';
    };
};

/** Explicitly initiated isolated diagnostic, only the requesting account's supplied registered device. */
export async function sendBoundaryTest(userId:string,token:string,runId:string){
 if(process.env.LOCATION_TEST_MODE!=='true'||!await DeviceToken.findOne({userId,token}))throw new Error('device unavailable');
 const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;if(!raw)throw new Error('push unavailable');
 const m=await getMessagingFor(JSON.parse(raw));
 await m.send({token,data:{kind:'boundary_test',runId,recipientId:userId},android:{priority:'high',ttl:60000}});
}
