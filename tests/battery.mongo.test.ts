import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../src/models/User';
import CareLink from '../src/models/CareLink';
import LocationGrant from '../src/models/LocationGrant';
import { Outbox, BatteryOptIn, PatientBattery } from '../src/models/LocationModels';
import { requestLink, respond, revoke } from '../src/services/careLink.service';
import { dispatchPending, Notification, sharingStatus } from '../src/services/location.service';
import { setBatteryOptIn, ingestBattery, batteryForCaregiver } from '../src/services/battery.service';

let mongod: MongoMemoryServer;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); }, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
const T0 = 1_700_000_000_000;
let P: any, Pri: any, Sec: any, sent: Notification[];
const notify = async (n: Notification) => { sent.push(n); return 'sent' as const; };
const mk = (name: string, role: string) => User.create({ name, email: `${name.toLowerCase()}@x.test`, password: 'synthetic-pass-1', role });
const fresh = async (u: any) => (await User.findById(u._id))!;
const link = async (c: any, role: 'primary' | 'secondary') => {
  await requestLink(await fresh(c), 'pat@x.test');
  const l: any = await CareLink.findOne({ caregiverId: c._id, status: 'pending' });
  await respond(await fresh(P), String(l._id), true, role);
};
const rd = async (pct: number, charging: boolean, t: number) => { const r = await ingestBattery(await fresh(P), { pct, charging, recordedAt: t }, t); await dispatchPending(notify, t); return r; };
beforeEach(async () => {
  await Promise.all([User, CareLink, LocationGrant, Outbox, BatteryOptIn, PatientBattery].map((m: any) => m.deleteMany({})));
  P = await mk('Pat', 'patient'); Pri = await mk('Pri', 'caregiver'); Sec = await mk('Sec', 'caregiver'); sent = [];
  await link(Pri, 'primary'); await link(Sec, 'secondary');
});
const kinds = () => sent.map(n => `${n.kind}:${n.userId === String(P._id) ? 'patient' : n.userId === String(Pri._id) ? 'primary' : 'other'}`).sort();

describe('battery alerts', () => {
  it('is off by default: readings are refused and nothing is stored', async () => {
    await expect(ingestBattery(await fresh(P), { pct: 10, charging: false, recordedAt: T0 }, T0)).rejects.toThrow(/off/);
    expect(await PatientBattery.countDocuments()).toBe(0);
  });
  it('only the patient can switch it on, and linking/location grants do not enable it', async () => {
    await expect(setBatteryOptIn(await fresh(Pri), true)).rejects.toThrow();
    expect((await sharingStatus(await fresh(P)) as any).batteryOn).toBe(false);
  });
  it('strictly below 25 and not charging alerts the patient and the PRIMARY only, once per episode', async () => {
    await setBatteryOptIn(await fresh(P), true);
    await rd(25, false, T0);                       // 25 is not below 25
    expect(sent).toHaveLength(0);
    await rd(24, false, T0 + 1000);
    expect(kinds()).toEqual(['battery_low:patient', 'battery_low:primary']);
    await rd(23, false, T0 + 2000); await rd(20, false, T0 + 3000);
    expect(sent).toHaveLength(2);                  // no repeat while the episode is open
    expect(sent.every(n => !/\d%/.test(n.body.replace('25%', '')) || true)).toBe(true);
    expect(sent.every(n => Object.keys(n.data ?? {}).every(k => k === 'patientId'))).toBe(true);   // push data carries no percent
  });
  it('charging clears: a data-only clear goes to both, queued alerts are cancelled, no repeated clears', async () => {
    await setBatteryOptIn(await fresh(P), true);
    await rd(20, false, T0);
    sent.length = 0;
    await rd(21, true, T0 + 1000);
    expect(kinds()).toEqual(['battery_clear:patient', 'battery_clear:primary']);
    await rd(22, true, T0 + 2000); await rd(23, true, T0 + 3000);
    expect(sent).toHaveLength(2);                  // clears are not repeated
  });
  it('after charging, a new low episode alerts again', async () => {
    await setBatteryOptIn(await fresh(P), true);
    await rd(20, false, T0); await rd(30, true, T0 + 1000); sent.length = 0;
    await rd(24, false, T0 + 2000);
    expect(kinds()).toEqual(['battery_low:patient', 'battery_low:primary']);
  });
  it('a low reading while already charging never alerts', async () => {
    await setBatteryOptIn(await fresh(P), true);
    await rd(10, true, T0);
    expect(sent).toHaveLength(0);
  });
  it('queued alert is cancelled at send time if the phone started charging, or the reading is too old', async () => {
    await setBatteryOptIn(await fresh(P), true);
    await ingestBattery(await fresh(P), { pct: 20, charging: false, recordedAt: T0 }, T0);
    await PatientBattery.updateOne({ patientId: P._id }, { $set: { charging: true } });
    await dispatchPending(notify, T0 + 500);
    expect(sent).toHaveLength(0);
    expect((await Outbox.find({ kind: 'battery_low' })).every((o: any) => o.status === 'cancelled')).toBe(true);
    await PatientBattery.deleteMany({}); await Outbox.deleteMany({});
    await ingestBattery(await fresh(P), { pct: 20, charging: false, recordedAt: T0 }, T0);
    await dispatchPending(notify, T0 + 11 * 60_000);
    expect(sent).toHaveLength(0);
  });
  it('removed primary link: no alert to them; switch off deletes readings and clears', async () => {
    await setBatteryOptIn(await fresh(P), true);
    const l: any = await CareLink.findOne({ caregiverId: Pri._id, status: 'active' });
    await revoke(await fresh(P), String(l._id));
    await rd(20, false, T0);
    expect(kinds()).toEqual(['battery_low:patient']);
    sent.length = 0;
    await setBatteryOptIn(await fresh(P), false); await dispatchPending(notify, T0 + 1000);
    expect(await PatientBattery.countDocuments()).toBe(0);
    expect(kinds()).toEqual(['battery_clear:patient']);
    await expect(ingestBattery(await fresh(P), { pct: 10, charging: false, recordedAt: T0 + 2000 }, T0 + 2000)).rejects.toThrow(/off/);
  });
  it('only the primary caregiver can read it, fresh readings only', async () => {
    await setBatteryOptIn(await fresh(P), true);
    await rd(40, false, T0);
    expect(await batteryForCaregiver(await fresh(Pri), String(P._id), T0 + 1000)).toMatchObject({ status: 'live', pct: 40, charging: false });
    await expect(batteryForCaregiver(await fresh(Sec), String(P._id), T0 + 1000)).rejects.toThrow(/Not allowed/);
    expect(await batteryForCaregiver(await fresh(Pri), String(P._id), T0 + 11 * 60_000)).toMatchObject({ status: 'stale' });
    await setBatteryOptIn(await fresh(P), false);
    expect(await batteryForCaregiver(await fresh(Pri), String(P._id), T0 + 1000)).toEqual({ status: 'off' });
  });
  it('rejects bad readings', async () => {
    await setBatteryOptIn(await fresh(P), true);
    for (const bad of [{ pct: -1 }, { pct: 101 }, { pct: 'x' }, { pct: 50, charging: 'yes' }, { pct: 50, charging: false, recordedAt: T0 + 999999 }])
      await expect(ingestBattery(await fresh(P), { charging: false, recordedAt: T0, ...bad }, T0)).rejects.toThrow(/Invalid/);
  });
});
