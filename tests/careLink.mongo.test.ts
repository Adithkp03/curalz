import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../src/models/User';
import CareLink from '../src/models/CareLink';
import LocationGrant from '../src/models/LocationGrant';
import { requestLink, respond, revoke, listIncoming } from '../src/services/careLink.service';
import { grantLocation, hasLocationAuthority } from '../src/services/locationAuthority.service';

// Real MongoDB (in-memory mongod): real unique partial indexes and real concurrent operations.
let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.init(), CareLink.init(), LocationGrant.init()]);
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let p1: any, p2: any, c1: any, c2: any;
const mk = (name: string, role: string) => User.create({ name, email: `${name.toLowerCase()}@x.test`, password: 'synthetic-pass-1', role });
const fresh = async (u: any) => (await User.findById(u._id))!;
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), CareLink.deleteMany({}), LocationGrant.deleteMany({})]);
  [p1, p2, c1, c2] = await Promise.all([mk('P1', 'patient'), mk('P2', 'patient'), mk('C1', 'caregiver'), mk('C2', 'caregiver')]);
});
const hasAccess = async (c: any, p: any) => (await fresh(c)).linkedPatientIds.map(String).includes(String(p._id));
const openLink = (c: any, p: any) => CareLink.findOne({ caregiverId: c._id, patientId: p._id, status: { $in: ['pending', 'active'] } });

describe('care links on real MongoDB', () => {
  it('concurrent duplicate requests leave exactly one open link', async () => {
    await Promise.all(Array.from({ length: 8 }, () => requestLink(c1, 'p1@x.test')));
    expect(await CareLink.countDocuments({ caregiverId: c1._id, patientId: p1._id })).toBe(1);
  });
  it('pending grants nothing; approve grants; revoke removes', async () => {
    await requestLink(c1, 'p1@x.test'); const l: any = await openLink(c1, p1);
    expect(await hasAccess(c1, p1)).toBe(false);
    await respond(await fresh(p1), String(l._id), true);
    expect(await hasAccess(c1, p1)).toBe(true);
    await revoke(await fresh(p1), String(l._id));
    expect(await hasAccess(c1, p1)).toBe(false);
  });
  it('approve vs decline vs revoke races end consistent (30 rounds)', async () => {
    for (let i = 0; i < 30; i++) {
      await CareLink.deleteMany({}); await User.updateOne({ _id: c1._id }, { $set: { linkedPatientIds: [] } });
      await requestLink(c1, 'p1@x.test'); const l: any = await CareLink.findOne({ caregiverId: c1._id });
      const P = await fresh(p1), C = await fresh(c1);
      await Promise.allSettled([respond(P, String(l._id), true), respond(P, String(l._id), false), revoke(C, String(l._id)), revoke(P, String(l._id))]);
      const final: any = await CareLink.findById(l._id);
      expect(await hasAccess(c1, p1), `round ${i} status ${final.status}`).toBe(final.status === 'active');
    }
  });
  it('only one active primary even under concurrent approvals (unique index)', async () => {
    await requestLink(c1, 'p1@x.test'); await requestLink(c2, 'p1@x.test');
    const a: any = await openLink(c1, p1), b: any = await openLink(c2, p1);
    const P = await fresh(p1);
    const r = await Promise.allSettled([respond(P, String(a._id), true, 'primary'), respond(P, String(b._id), true, 'primary')]);
    expect(r.filter(x => x.status === 'fulfilled').length).toBe(1);
    const rejected = r.find(x => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    expect(await CareLink.countDocuments({ patientId: p1._id, status: 'active', role: 'primary' })).toBe(1);
    expect((await hasAccess(c1, p1)) !== (await hasAccess(c2, p1))).toBe(true);
  });
  it('legacy seeded link is adopted once, even when listed concurrently, and stays revocable', async () => {
    await User.updateOne({ _id: c1._id }, { $set: { linkedPatientIds: [p1._id] } });
    const P = await fresh(p1);
    await Promise.all([listIncoming(P), listIncoming(P), listIncoming(P)]);
    expect(await CareLink.countDocuments({ patientId: p1._id, status: 'active', legacy: true })).toBe(1);
    const rows: any = await listIncoming(P);
    await revoke(P, rows[0].id);
    expect(await hasAccess(c1, p1)).toBe(false);
  });
  it('location authority needs an explicit grant; revoking the link ends it and re-link starts at zero', async () => {
    await User.updateOne({ _id: c1._id }, { $set: { linkedPatientIds: [p1._id] } });
    const P = await fresh(p1); const rows: any = await listIncoming(P);
    expect(await hasLocationAuthority(c1._id, p1._id)).toBe(false);   // legacy link alone
    await grantLocation(P, String(c1._id));
    expect(await hasLocationAuthority(c1._id, p1._id)).toBe(true);
    await revoke(P, rows[0].id);
    expect(await hasLocationAuthority(c1._id, p1._id)).toBe(false);
    await requestLink(await fresh(c1), 'p1@x.test'); const l: any = await openLink(c1, p1);
    await respond(P, String(l._id), true);
    expect(await hasLocationAuthority(c1._id, p1._id)).toBe(false);   // new link, no inherited grant
  });
  it('caregiver cannot approve; other patient cannot respond', async () => {
    await requestLink(c1, 'p1@x.test'); const l: any = await openLink(c1, p1);
    await expect(respond(await fresh(c1), String(l._id), true)).rejects.toThrow('Only the patient');
    await expect(respond(await fresh(p2), String(l._id), true)).rejects.toThrow('No pending');
    expect(await hasAccess(c1, p1)).toBe(false);
  });
});
