import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../src/models/User';
import CareLink from '../src/models/CareLink';
import LocationGrant from '../src/models/LocationGrant';
import { SafeZone, PatientLocationState, Outbox, DeviceToken } from '../src/models/LocationModels';
import { setZone, ingestPatientFix, dispatchPending, onAccessEnded, Notification } from '../src/services/location.service';
import { BoundaryEpisode as Ep, BoundaryRepeatState as RS, BoundaryRepeatEvent as RE, openEpisode, noteEpisodeFix, stopRepeat, readRepeatEvent, sweepRepeats, repeatCronAuthorized, repeatEnabled, repeatSchedulerActive } from '../src/boundary-repeat/service';

// SYNTHETIC coordinates only, real MongoDB. Exercises the service layer, not push delivery.
let db: MongoMemoryServer;
beforeAll(async () => {
  db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  await Promise.all([User, CareLink, LocationGrant, SafeZone, PatientLocationState, Outbox, DeviceToken, Ep, RS, RE].map((m: any) => m.init()));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await db.stop(); });

const HOME = { lat: 10.0, lon: 76.0, radiusM: 300 };
const offset = (m: number) => ({ lat: HOME.lat + m / 111_320, lon: HOME.lon });
const fix = (m: number, t: number, acc = 10) => ({ ...offset(m), accuracyM: acc, recordedAt: t });
const T = 1_700_000_000_000, MIN = 60_000;
let P: any, A: any, B: any, sends: Notification[];
const send = async (n: any) => { sends.push(n); return 'sent' as const; };
const flush = (now: number) => dispatchPending(send, now);
const pf = async (f: any, now: number) => { const r = await ingestPatientFix(P, f, now); await flush(now); return r; };
const actor = (u: any) => ({ _id: u._id, role: 'caregiver' });

beforeEach(async () => {
  process.env.LOCATION_TEST_MODE = 'true'; process.env.LOCATION_FEATURE_ENABLED = 'true'; process.env.BOUNDARY_REPEAT_ENABLED = 'true';
  delete process.env.BOUNDARY_REPEAT_CRON_SECRET; delete process.env.BOUNDARY_REPEAT_SCHEDULER_ACTIVE;
  await Promise.all([User, CareLink, LocationGrant, SafeZone, PatientLocationState, Outbox, DeviceToken, Ep, RS, RE].map((m: any) => m.deleteMany({})));
  sends = [];
  P = await User.create({ name: 'Pat', email: 'pat@x.test', password: 'synthetic-pass-1', role: 'patient' });
  A = await User.create({ name: 'Ann', email: 'ann@x.test', password: 'synthetic-pass-1', role: 'caregiver' });
  B = await User.create({ name: 'Bob', email: 'bob@x.test', password: 'synthetic-pass-1', role: 'caregiver' });
  await CareLink.create({ patientId: P._id, caregiverId: A._id, role: 'primary', status: 'active' });
  await CareLink.create({ patientId: P._id, caregiverId: B._id, role: 'secondary', status: 'active' });
  await LocationGrant.create({ patientId: P._id, caregiverId: A._id, status: 'active' });
  await LocationGrant.create({ patientId: P._id, caregiverId: B._id, status: 'active' });
  await DeviceToken.create({ userId: A._id, token: 'synthetic-repeat-token-a', boundaryRepeatV1: true });
  await DeviceToken.create({ userId: B._id, token: 'synthetic-repeat-token-b', boundaryRepeatV1: true });
  await setZone(actor(A), String(P._id), HOME);
});

/** Confirmed exit at T+60s: first alert outbox rows plus one open episode whose clock starts at the first alert. */
const cross = async () => {
  await pf(fix(400, T), T);
  const r = await pf(fix(400, T + MIN), T + MIN);
  expect(r.alert).toBe(true);
  const ep: any = await Ep.findOne({ patientId: P._id, open: true });
  expect(ep).toBeTruthy(); expect(ep.openedAt).toBe(T + MIN);
  expect(await RS.countDocuments({ episodeId: ep._id })).toBe(2);
  expect(await Outbox.countDocuments({ kind: 'patient_left_zone', status: 'sent' })).toBe(2);
  sends = []; // ignore the first-alert sends; repeats are what this suite checks
  return ep;
};

it('module is off by default and the cron secret fails closed', async () => {
  delete process.env.BOUNDARY_REPEAT_ENABLED;
  expect(repeatEnabled()).toBe(false); expect(repeatSchedulerActive()).toBe(false);
  expect(await sweepRepeats(send, T)).toEqual({ enabled: false });
  expect(repeatCronAuthorized('Bearer ' + 'x'.repeat(40))).toBe(false);
  process.env.BOUNDARY_REPEAT_ENABLED = 'true'; process.env.BOUNDARY_REPEAT_CRON_SECRET = 'x'.repeat(40);
  expect(repeatCronAuthorized('Bearer ' + 'x'.repeat(40))).toBe(true);
  expect(repeatCronAuthorized('Bearer ' + 'x'.repeat(39))).toBe(false);
  expect(repeatSchedulerActive()).toBe(false);
  process.env.BOUNDARY_REPEAT_SCHEDULER_ACTIVE = 'true'; expect(repeatSchedulerActive()).toBe(true);
});

it('no repeat before ten minutes; exactly one per caregiver at ten; no catch-up burst after a late sweep', async () => {
  const ep = await cross();
  let r: any = await sweepRepeats(send, T + MIN + 599_999);
  expect(r.waiting).toBe(2); expect(sends).toHaveLength(0);
  r = await sweepRepeats(send, T + MIN + 600_000);
  expect(r.sent).toBe(2); expect(sends).toHaveLength(2);
  expect(sends.every((x: any) => x.kind === 'boundary_repeat' && x.data.episodeId === String(ep._id) && !('lat' in x.data) && !('lon' in x.data))).toBe(true);
  r = await sweepRepeats(send, T + MIN + 600_001); expect(r.sent).toBe(0); expect(sends).toHaveLength(2);
  r = await sweepRepeats(send, T + MIN + 3_600_000); // an hour late: one slot, never a burst
  expect(r.sent).toBe(2); expect(sends).toHaveLength(4);
});

it('fresh outside fix yields outside_reminder with the current fix; stale yields unresolved_reminder with the last-seen snapshot', async () => {
  const ep = await cross();
  await pf(fix(500, T + 9 * MIN), T + 9 * MIN); // fresh outside 1 min before the repeat is due
  await sweepRepeats(send, T + 11 * MIN);
  expect(sends).toHaveLength(2);
  const ev: any = await RE.findOne({ episodeId: ep._id, userId: A._id });
  expect(ev.kind).toBe('outside_reminder'); expect(ev.lastSeen.recordedAt).toBe(T + 9 * MIN);
  const read = await readRepeatEvent(actor(A), String(ev._id));
  expect(read.kind).toBe('outside_reminder'); expect(read.lastSeen.lat).toBeCloseTo(offset(500).lat, 6); expect(read.stopped).toBe(false);
  // then the phone goes silent: next repeat is an unresolved reminder carrying the last outside fix
  await sweepRepeats(send, T + 21 * MIN);
  const evs: any[] = await RE.find({ episodeId: ep._id, userId: A._id }).sort({ occurredAt: 1 });
  expect(evs).toHaveLength(2);
  expect(evs[1].kind).toBe('unresolved_reminder'); expect(evs[1].lastSeen.recordedAt).toBe(T + 9 * MIN);
});

it('Stop silences only that caregiver, idempotently; the crossing stays open for the other', async () => {
  const ep = await cross();
  const r1 = await stopRepeat(actor(A), String(ep._id), T + 2 * MIN);
  expect(r1.stopped).toBe(true); expect(r1.closed).toBeNull();
  const r2 = await stopRepeat(actor(A), String(ep._id), T + 3 * MIN); // idempotent
  expect(r2.stopped).toBe(true);
  await sweepRepeats(send, T + 11 * MIN);
  expect(sends).toHaveLength(1); expect(sends[0].userId).toBe(String(B._id));
  await sweepRepeats(send, T + 21 * MIN);
  expect(sends).toHaveLength(2); expect(sends[1].userId).toBe(String(B._id));
  await expect(stopRepeat(actor(await User.create({ name: 'Eve', email: 'eve@x.test', password: 'synthetic-pass-1', role: 'caregiver' })), String(ep._id))).rejects.toThrow();
});

it('a fresh clearly-inside fix closes the crossing; edge or stale fixes do not', async () => {
  const ep = await cross();
  await pf(fix(280, T + 2 * MIN, 5), T + 2 * MIN); // inside but not clearly (280+5 > 0.9*300): stays open
  expect(await Ep.exists({ _id: ep._id, open: true })).toBeTruthy();
  await pf(fix(0, T + 3 * MIN), T + 3 * MIN);       // clearly inside: auto-close
  const closed: any = await Ep.findById(ep._id);
  expect(closed.closed).toBe('returned'); expect(closed.open).toBe(false);
  expect(await RS.countDocuments({ episodeId: ep._id })).toBe(0);
  const r: any = await sweepRepeats(send, T + 11 * MIN);
  expect(r.sent).toBe(0); expect(sends).toHaveLength(0);
});

it('sweep itself closes on fresh clearly-inside evidence even if the ingest hook was bypassed', async () => {
  const ep = await cross();
  await PatientLocationState.updateOne({ patientId: P._id }, { $set: { lastFix: fix(0, T + 10 * MIN) } });
  const r: any = await sweepRepeats(send, T + 10 * MIN);
  expect(r.closed).toBe(1);
  expect((await Ep.findById(ep._id))!.closed).toBe('returned');
});

it('a zone change closes the crossing and no repeats ever reference the old zone', async () => {
  const ep = await cross();
  await setZone(actor(A), String(P._id), { ...HOME, radiusM: 400 });
  expect((await Ep.findById(ep._id))!.closed).toBe('zone_changed');
  const r: any = await sweepRepeats(send, T + 11 * MIN);
  expect(r.sent).toBe(0); expect(sends).toHaveLength(0);
});

it('revocation stops that caregiver only; revoking everyone closes the crossing; re-link never revives it', async () => {
  const ep = await cross();
  await LocationGrant.updateOne({ patientId: P._id, caregiverId: B._id }, { $set: { status: 'revoked' } });
  await onAccessEnded(P._id, B._id);
  await sweepRepeats(send, T + 11 * MIN);
  expect(sends).toHaveLength(1); expect(sends[0].userId).toBe(String(A._id));
  await LocationGrant.updateOne({ patientId: P._id, caregiverId: A._id }, { $set: { status: 'revoked' } });
  await onAccessEnded(P._id, A._id);
  expect((await Ep.findById(ep._id))!.closed).toBe('sharing_ended');
  // re-link + re-grant: the old crossing must not come back
  await LocationGrant.create({ patientId: P._id, caregiverId: A._id, status: 'active' });
  const r: any = await sweepRepeats(send, T + 30 * MIN);
  expect(r.sent).toBe(0); expect(sends).toHaveLength(1);
  expect(await Ep.countDocuments({ patientId: P._id, open: true })).toBe(0);
});

it('no capable device means no claim and no event; a later capable device still gets the next slot', async () => {
  const ep = await cross();
  await DeviceToken.updateMany({}, { $set: { boundaryRepeatV1: false } });
  let r: any = await sweepRepeats(send, T + 11 * MIN);
  expect(r.waitingForDevice).toBe(2); expect(sends).toHaveLength(0);
  expect(await RE.countDocuments({ episodeId: ep._id })).toBe(0);
  expect((await RS.findOne({ episodeId: ep._id, caregiverId: A._id }))!.lastAttemptAt).toBeUndefined();
  await DeviceToken.updateOne({ userId: A._id }, { $set: { boundaryRepeatV1: true } });
  r = await sweepRepeats(send, T + 12 * MIN);
  expect(r.sent).toBe(1); expect(sends).toHaveLength(1); expect(sends[0].userId).toBe(String(A._id));
});

it('an ambiguous provider failure claims the slot and is never replayed immediately', async () => {
  await cross();
  let attempts = 0;
  const flaky = async () => { attempts++; throw new Error('ambiguous'); };
  const r: any = await sweepRepeats(flaky, T + 11 * MIN);
  expect(r.failed).toBe(2); expect(attempts).toBe(2);
  await sweepRepeats(send, T + 11 * MIN + 1000);
  expect(sends).toHaveLength(0); // same slot already claimed
  await sweepRepeats(send, T + 21 * MIN);
  expect(sends).toHaveLength(2); // next slot works
});

it('parallel sweeps claim each caregiver slot once', async () => {
  await cross();
  await Promise.all([sweepRepeats(send, T + 11 * MIN), sweepRepeats(send, T + 11 * MIN), sweepRepeats(send, T + 11 * MIN)]);
  expect(sends).toHaveLength(2);
});

it('display re-checks recipient, open episode and current consent', async () => {
  const ep = await cross();
  await sweepRepeats(send, T + 11 * MIN);
  const ev: any = await RE.findOne({ episodeId: ep._id, userId: A._id });
  const read = await readRepeatEvent(actor(A), String(ev._id));
  expect(read.episodeId).toBe(String(ep._id)); expect(read.openedAt).toBe(T + MIN);
  await expect(readRepeatEvent(actor(B), String(ev._id))).rejects.toThrow();
  await expect(readRepeatEvent({ _id: P._id, role: 'patient' }, String(ev._id))).rejects.toThrow();
  await LocationGrant.updateOne({ patientId: P._id, caregiverId: A._id }, { $set: { status: 'revoked' } });
  await expect(readRepeatEvent(actor(A), String(ev._id))).rejects.toThrow();
  await LocationGrant.updateOne({ patientId: P._id, caregiverId: A._id }, { $set: { status: 'active' } });
  await pf(fix(0, T + 12 * MIN), T + 12 * MIN); // returns inside: episode closes, event goes stale
  await expect(readRepeatEvent(actor(A), String(ev._id))).rejects.toThrow();
});

it('a second confirmed exit opens a NEW episode with a fresh clock and cleared stops', async () => {
  const ep1 = await cross();
  await stopRepeat(actor(A), String(ep1._id), T + 2 * MIN);
  await pf(fix(0, T + 3 * MIN), T + 3 * MIN);          // back inside: closes ep1
  await pf(fix(400, T + 4 * MIN), T + 4 * MIN);        // new exit
  const r = await pf(fix(400, T + 5 * MIN), T + 5 * MIN);
  expect(r.alert).toBe(true);
  const ep2: any = await Ep.findOne({ patientId: P._id, open: true });
  expect(String(ep2._id)).not.toBe(String(ep1._id)); expect(ep2.openedAt).toBe(T + 5 * MIN);
  sends = [];
  await sweepRepeats(send, T + 5 * MIN + 600_000);
  expect(sends).toHaveLength(2); // A is reminded again: Stop never carries across crossings
});

it('ingest hook keeps the last-seen snapshot current without a sweep', async () => {
  const ep = await cross();
  await pf(fix(600, T + 2 * MIN), T + 2 * MIN);
  const fresh: any = await Ep.findById(ep._id);
  expect(fresh.lastOutsideFix.recordedAt).toBe(T + 2 * MIN);
  await pf(fix(700, T - 1000), T + 3 * MIN); // out-of-order old fix: rejected by the state store, snapshot untouched
  expect((await Ep.findById(ep._id))!.lastOutsideFix.recordedAt).toBe(T + 2 * MIN);
});

it('openEpisode is idempotent per alert and per patient', async () => {
  const z: any = await SafeZone.findOne({ patientId: P._id });
  const f = fix(400, T + MIN);
  await openEpisode(P._id, z.rev, f, [String(A._id), String(B._id)], 'synthetic-alert-1', T + MIN);
  await openEpisode(P._id, z.rev, f, [String(A._id), String(B._id)], 'synthetic-alert-1', T + MIN);
  await openEpisode(P._id, z.rev, f, [String(A._id)], 'synthetic-alert-2', T + 2 * MIN);
  expect(await Ep.countDocuments({ patientId: P._id, open: true })).toBe(1);
  expect(await RS.countDocuments()).toBe(2);
  await noteEpisodeFix(P._id, fix(500, T + 3 * MIN), { ...HOME, rev: z.rev }, T + 3 * MIN);
  expect((await Ep.findOne({ patientId: P._id, open: true }))!.lastOutsideFix.recordedAt).toBe(T + 3 * MIN);
});
