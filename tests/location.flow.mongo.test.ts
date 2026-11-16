import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../src/models/User';
import CareLink from '../src/models/CareLink';
import LocationGrant from '../src/models/LocationGrant';
import { SafeZone, PatientLocationState, CaregiverFix, NearbyStateModel } from '../src/models/LocationModels';
import { requestLink, respond } from '../src/services/careLink.service';
import { grantLocation, revokeLocation } from '../src/services/locationAuthority.service';
import { CaregiverSharing, Outbox } from '../src/models/LocationModels';
import { revoke } from '../src/services/careLink.service';
import { setZone, getZone, ingestPatientFix, ingestCaregiverFix, liveLocation, setCaregiverSharing, dispatchPending, Notification } from '../src/services/location.service';

// SYNTHETIC coordinates only, real MongoDB. Disabled-by-default feature; this exercises the service layer, not push delivery.
let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri());
  await Promise.all([User, CareLink, LocationGrant, SafeZone, PatientLocationState, CaregiverFix, NearbyStateModel, CaregiverSharing, Outbox].map((m: any) => m.init()));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

const HOME = { lat: 10.0, lon: 76.0, radiusM: 300 };
const offset = (m: number) => ({ lat: HOME.lat + m / 111_320, lon: HOME.lon });
const T0 = 1_700_000_000_000;
let P: any, Pri: any, Sec: any, Stranger: any, sent: Notification[];
const notify = async (n: Notification) => { sent.push(n); return 'sent' as const; };
const flush = (now: number) => dispatchPending(notify, now);
// ingest then dispatch at the same instant, like the route does
const pf = async (p: any, f: any, now: number) => { const r = await ingestPatientFix(p, f, now); await flush(now); return r; };
const cf = async (c: any, f: any, now: number) => { const r = await ingestCaregiverFix(c, f, now); await flush(now); return r; };
const optIn = async (c: any) => setCaregiverSharing(await fresh(c), true);
const mk = (name: string, role: string) => User.create({ name, email: `${name.toLowerCase()}@x.test`, password: 'synthetic-pass-1', role });
const fresh = async (u: any) => (await User.findById(u._id))!;
const link = async (c: any, role: 'primary' | 'secondary') => {
  await requestLink(await fresh(c), 'pat@x.test');
  const l: any = await CareLink.findOne({ caregiverId: c._id, status: 'pending' });
  await respond(await fresh(P), String(l._id), true, role);
};
const fix = (m: number, t: number, acc = 10) => ({ ...offset(m), accuracyM: acc, recordedAt: t });

beforeEach(async () => {
  sent = [];
  await Promise.all([User, CareLink, LocationGrant, SafeZone, PatientLocationState, CaregiverFix, NearbyStateModel, CaregiverSharing, Outbox].map((m: any) => m.deleteMany({})));
  [P, Pri, Sec, Stranger] = await Promise.all([mk('Pat', 'patient'), mk('Pri', 'caregiver'), mk('Sec', 'caregiver'), mk('Str', 'caregiver')]);
  await link(Pri, 'primary'); await link(Sec, 'secondary');
});

describe('boundary + sharing flow (synthetic, real MongoDB)', () => {
  it('no zone or fix works before the patient opts in; legacy-style active link alone is not enough', async () => {
    await expect(setZone(await fresh(Pri), String(P._id), HOME)).rejects.toThrow(/primary caregiver/);
    await expect(pf(await fresh(P), fix(0, T0), T0)).rejects.toThrow('Location sharing is off');
  });
  it('only the primary can set or change the zone; secondary, stranger and patient cannot', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await grantLocation(await fresh(P), String(Sec._id));
    await expect(setZone(await fresh(Sec), String(P._id), HOME)).rejects.toThrow(/primary/);
    await expect(setZone(await fresh(Stranger), String(P._id), HOME)).rejects.toThrow(/primary/);
    await expect(setZone(await fresh(P), String(P._id), HOME)).rejects.toThrow(/Only a caregiver/);
    await setZone(await fresh(Pri), String(P._id), HOME);
    await setZone(await fresh(Pri), String(P._id), { ...HOME, radiusM: 500 });
    expect((await getZone(await fresh(Sec), String(P._id)))!.radiusM).toBe(500);
    await expect(getZone(await fresh(Stranger), String(P._id))).rejects.toThrow('Not allowed');
    await expect(setZone(await fresh(Pri), String(P._id), { ...HOME, radiusM: 5 })).rejects.toThrow('Invalid boundary');
    await expect(setZone(await fresh(Pri), 'not-an-id', HOME)).rejects.toThrow('Invalid id');
  });
  it('exit alerts reach both primary and secondary with the live position, once, until re-entry', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await grantLocation(await fresh(P), String(Sec._id));
    await setZone(await fresh(Pri), String(P._id), HOME);
    const pat = await fresh(P);
    await pf(pat, fix(0, T0), T0);
    await pf(pat, fix(800, T0 + 10_000), T0 + 10_000);
    expect(sent).toHaveLength(0);                                  // one outside fix is not confirmed
    const r = await pf(pat, fix(820, T0 + 80_000), T0 + 80_000);
    expect(r.alert).toBe(true);
    expect(sent.map(s => s.userId).sort()).toEqual([String(Pri._id), String(Sec._id)].sort());
    expect(sent.every(s => s.kind === 'patient_left_zone' && s.data!.lat)).toBe(true);
    await pf(pat, fix(850, T0 + 100_000), T0 + 100_000);
    expect(sent).toHaveLength(2);                                  // no repeat while still outside
    const live = await liveLocation(await fresh(Sec), String(P._id), T0 + 110_000);
    expect(live!.ageMs).toBe(10_000);
    await expect(liveLocation(await fresh(Stranger), String(P._id))).rejects.toThrow('Not allowed');
  });
  it('turning sharing off stops alerts and live access immediately', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
    await revokeLocation(await fresh(P), String(P._id), String(Pri._id));
    await expect(pf(await fresh(P), fix(900, T0), T0)).rejects.toThrow('Location sharing is off');
    await expect(liveLocation(await fresh(Pri), String(P._id))).rejects.toThrow('Not allowed');
  });
  it('a caregiver without a grant gets no alert even when another one has it', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
    const pat = await fresh(P);
    await pf(pat, fix(900, T0), T0); await pf(pat, fix(900, T0 + 70_000), T0 + 70_000);
    expect(sent.map(s => s.userId)).toEqual([String(Pri._id)]);
  });
  it('patient is told the caregiver is nearby once; far caregiver gives nothing; nobody else is told', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await optIn(Pri); await optIn(Sec);
    const pat = await fresh(P);
    await pf(pat, fix(0, T0), T0);
    await cf(await fresh(Pri), fix(2000, T0), T0);
    expect(sent).toHaveLength(0);
    await cf(await fresh(Pri), fix(60, T0 + 20_000), T0 + 20_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: String(P._id), kind: 'caregiver_nearby' });
    await cf(await fresh(Pri), fix(50, T0 + 40_000), T0 + 40_000);
    expect(sent).toHaveLength(1);
    await cf(await fresh(Sec), fix(10, T0 + 40_000), T0 + 40_000);   // no grant: nothing
    expect(sent).toHaveLength(1);
  });
  it('concurrent fixes produce exactly one alert', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
    const pat = await fresh(P);
    await pf(pat, fix(900, T0), T0);
    await Promise.all([1, 2, 3, 4, 5, 6].map(i => ingestPatientFix(pat, fix(900 + i, T0 + 70_000 + i), T0 + 80_000)));
    await flush(T0 + 80_000);
    expect(sent.filter(s => s.kind === 'patient_left_zone')).toHaveLength(1);   // exactly one, to the one granted caregiver
  });
  it('malformed fixes are rejected', async () => {
    await grantLocation(await fresh(P), String(Pri._id));
    for (const bad of [{}, { lat: 99, lon: 0, accuracyM: 1, recordedAt: 1 }, { lat: 'x', lon: 0, accuracyM: 1, recordedAt: 1 }])
      await expect(pf(await fresh(P), bad, T0)).rejects.toThrow('Invalid location fix');
  });

  it('nearby needs the caregiver\'s own opt-in too, not only the patient grant', async () => {
    await grantLocation(await fresh(P), String(Pri._id));
    await expect(ingestCaregiverFix(await fresh(Pri), fix(10, T0), T0)).rejects.toThrow('Your location sharing is off');
    await pf(await fresh(P), fix(0, T0), T0);
    expect(sent).toHaveLength(0);
    await optIn(Pri);
    await cf(await fresh(Pri), fix(30, T0 + 1000), T0 + 1000);
    expect(sent.filter(s => s.kind === 'caregiver_nearby')).toHaveLength(1);
    await setCaregiverSharing(await fresh(Pri), false);
    expect(await CaregiverFix.countDocuments({})).toBe(0);                 // their stored position is deleted on opt-out
  });
  it('zone change after an alert is queued cancels it; nothing is sent', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
    const pat = await fresh(P);
    await ingestPatientFix(pat, fix(900, T0), T0); await ingestPatientFix(pat, fix(900, T0 + 70_000), T0 + 70_000);
    expect(await Outbox.countDocuments({ status: 'queued' })).toBe(1);
    await setZone(await fresh(Pri), String(P._id), { ...HOME, radiusM: 2000 });
    await flush(T0 + 71_000);
    expect(sent).toHaveLength(0);
    expect((await Outbox.findOne({}))!.status).toBe('cancelled');
  });
  it('opt-out, grant revoke and link revoke cancel queued alerts and wipe stored position', async () => {
    for (const how of ['optout', 'grant', 'link']) {
      sent = []; await Promise.all([Outbox, PatientLocationState].map((m: any) => m.deleteMany({})));
      await LocationGrant.deleteMany({}); await SafeZone.deleteMany({});
      await CareLink.updateMany({ caregiverId: Pri._id }, { $set: { status: 'active' } });
      await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
      const pat = await fresh(P);
      await ingestPatientFix(pat, fix(900, T0), T0); await ingestPatientFix(pat, fix(900, T0 + 70_000), T0 + 70_000);
      expect(await Outbox.countDocuments({ status: 'queued' })).toBe(1);
      if (how === 'grant') await revokeLocation(pat, String(P._id), String(Pri._id));
      if (how === 'link') { const l: any = await CareLink.findOne({ caregiverId: Pri._id, status: 'active' }); await revoke(pat, String(l._id)); }
      if (how === 'optout') { await revokeLocation(pat, String(P._id), String(Pri._id)); }
      await flush(T0 + 71_000);
      expect(sent).toHaveLength(0);
      expect(await PatientLocationState.countDocuments({})).toBe(0);
    }
  });
  it('a stale fix is never reported as live; fix too old at send time is not disclosed', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
    const pat = await fresh(P);
    await ingestPatientFix(pat, fix(900, T0), T0); await ingestPatientFix(pat, fix(900, T0 + 70_000), T0 + 70_000);
    const fresh1: any = await liveLocation(await fresh(Pri), String(P._id), T0 + 80_000);
    expect(fresh1.status).toBe('live');
    const old: any = await liveLocation(await fresh(Pri), String(P._id), T0 + 70_000 + 6 * 60_000);
    expect(old).toEqual({ status: 'stale', ageMs: 6 * 60_000 });          // no coordinates in a stale answer
    await flush(T0 + 70_000 + 6 * 60_000);
    expect(sent).toHaveLength(0);
    expect((await Outbox.findOne({}))!.reason).toMatch(/too old/);
  });
  it('outbox states: logged is not sent; sender errors become failed; no double send', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
    const pat = await fresh(P);
    await ingestPatientFix(pat, fix(900, T0), T0); await ingestPatientFix(pat, fix(900, T0 + 70_000), T0 + 70_000);
    const r = await dispatchPending(async () => 'logged', T0 + 71_000);
    expect(r).toMatchObject({ logged: 1, sent: 0 });
    expect((await Outbox.findOne({}))!.status).toBe('logged');
    expect(await dispatchPending(async () => 'sent', T0 + 72_000)).toMatchObject({ sent: 0 });   // not re-sent
  });
  it('a zone set by a caregiver who is no longer primary is ignored', async () => {
    await grantLocation(await fresh(P), String(Pri._id)); await setZone(await fresh(Pri), String(P._id), HOME);
    await CareLink.updateOne({ caregiverId: Pri._id }, { $set: { status: 'revoked' } });
    await grantLocation(await fresh(P), String(Sec._id)).catch(() => null);
    await LocationGrant.create({ patientId: P._id, caregiverId: Sec._id, status: 'active' }).catch(() => null);
    const pat = await fresh(P);
    await pf(pat, fix(900, T0), T0); await pf(pat, fix(900, T0 + 70_000), T0 + 70_000);
    expect(sent).toHaveLength(0);
  });
});
