import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal stateful fakes so access behaviour and races are tested, not just call shapes.
const db = vi.hoisted(() => {
  const state: any = { users: [], links: [], n: 0 };
  const match = (doc: any, f: any): boolean => Object.entries(f).every(([k, v]: any) => {
    const x = doc[k];
    if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(x));
    if (Array.isArray(x)) return x.map(String).includes(String(v));
    return String(x) === String(v);
  });
  const wrap = (arr: any[]) => Object.assign(Promise.resolve(arr), { select: () => Promise.resolve(arr) });
  const OPEN = ['pending', 'active'];
  const dupOpen = (d: any, skip?: any) => state.links.some((l: any) => l !== skip && OPEN.includes(l.status) && OPEN.includes(d.status) &&
    String(l.patientId) === String(d.patientId) && String(l.caregiverId) === String(d.caregiverId));
  const dupPrimary = (d: any, skip?: any) => d.status === 'active' && d.role === 'primary' && state.links.some((l: any) => l !== skip &&
    l.status === 'active' && l.role === 'primary' && String(l.patientId) === String(d.patientId));
  const User = {
    findOne: async (f: any) => state.users.find((u: any) => match(u, f)) ?? null,
    find: (f: any) => wrap(state.users.filter((u: any) => match(u, f))),
    updateOne: async (f: any, u: any) => {
      const user = state.users.find((x: any) => match(x, f)); if (!user) return;
      if (u.$addToSet) { const id = u.$addToSet.linkedPatientIds; if (!user.linkedPatientIds.map(String).includes(String(id))) user.linkedPatientIds.push(id); }
      if (u.$pull) user.linkedPatientIds = user.linkedPatientIds.filter((p: any) => String(p) !== String(u.$pull.linkedPatientIds));
    },
  };
  const CareLink = {
    findOne: async (f: any) => state.links.find((l: any) => match(l, f)) ?? null,
    find: async (f: any) => state.links.filter((l: any) => match(l, f)),
    create: async (d: any) => {
      const doc = { _id: (++state.n).toString(16).padStart(24, 'e'), role: 'secondary', legacy: false, ...d };
      if (dupOpen(doc) || dupPrimary(doc)) throw Object.assign(new Error('dup'), { code: 'DUP' });
      state.links.push(doc); return doc;
    },
    findOneAndUpdate: async (f: any, u: any) => {
      await Promise.resolve(); // yield so concurrent callers interleave
      const l = state.links.find((x: any) => match(x, f)); if (!l) return null;
      const next = { ...l, ...u.$set };
      if (dupPrimary(next, l)) throw Object.assign(new Error('dup'), { code: 'DUP' });
      Object.assign(l, u.$set); return l;
    },
  };
  return { state, User, CareLink };
});
vi.mock('../src/models/User', () => ({ default: db.User }));
vi.mock('../src/models/CareLink', () => ({ default: db.CareLink }));
import { requestLink, respond, revoke, listIncoming, listOutgoing } from '../src/services/careLink.service';

const hex = (c: string) => c.repeat(24);
const P1 = { _id: hex('1'), role: 'patient', email: 'p1@x.com', name: 'Pat One', linkedPatientIds: [] as any[] };
const P2 = { _id: hex('2'), role: 'patient', email: 'p2@x.com', name: 'Pat Two', linkedPatientIds: [] as any[] };
const C1 = { _id: hex('a'), role: 'caregiver', email: 'c1@x.com', name: 'Maya', linkedPatientIds: [] as any[] };
const C2 = { _id: hex('b'), role: 'caregiver', email: 'c2@x.com', name: 'Ravi', linkedPatientIds: [] as any[] };
const has = (c: any, p: any) => c.linkedPatientIds.map(String).includes(String(p._id));
const only = async (c: any, p: any) => (await db.CareLink.find({ caregiverId: c._id, patientId: p._id })).find((l: any) => ['pending', 'active'].includes(l.status));

beforeEach(() => {
  db.state.links = []; db.state.n = 0;
  for (const u of [P1, P2, C1, C2]) u.linkedPatientIds = [];
  db.state.users = [P1, P2, C1, C2];
});

describe('request', () => {
  it('creates a pending link that grants nothing', async () => {
    await requestLink(C1, 'P1@x.com');
    expect((await only(C1, P1)).status).toBe('pending');
    expect(has(C1, P1)).toBe(false);
  });
  it('same reply whether or not the patient exists; no link for non-patients', async () => {
    const a = await requestLink(C1, 'nobody@x.com');
    const b = await requestLink(C1, 'p1@x.com');
    const c = await requestLink(C1, 'c2@x.com'); // a caregiver address
    expect(a).toEqual(b); expect(a).toEqual(c);
    expect(db.state.links.length).toBe(1);
  });
  it('concurrent duplicate requests create one link', async () => {
    await Promise.all([requestLink(C1, 'p1@x.com'), requestLink(C1, 'p1@x.com'), requestLink(C1, 'p1@x.com')]);
    expect(db.state.links.length).toBe(1);
  });
  it('patients cannot request; bad input rejected', async () => {
    await expect(requestLink(P1, 'p2@x.com')).rejects.toThrow('Only caregivers');
    await expect(requestLink(C1, 42)).rejects.toThrow('Valid patient email');
  });
  it('declined or revoked links can be requested again', async () => {
    await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
    await respond(P1, l._id, false);
    await requestLink(C1, 'p1@x.com');
    expect((await only(C1, P1)).status).toBe('pending');
  });
});

describe('what each state grants', () => {
  it('pending and declined grant nothing; approve grants; revoke removes', async () => {
    await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
    expect(has(C1, P1)).toBe(false);
    await respond(P1, l._id, true);
    expect(has(C1, P1)).toBe(true);
    await revoke(P1, l._id);
    expect(has(C1, P1)).toBe(false);
    await requestLink(C1, 'p1@x.com'); const l2 = await only(C1, P1);
    await respond(P1, l2._id, false);
    expect(has(C1, P1)).toBe(false);
  });
  it('caregiver can revoke their own link', async () => {
    await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
    await respond(P1, l._id, true);
    await revoke(C1, l._id);
    expect(has(C1, P1)).toBe(false);
  });
});

describe('unauthorized operations', () => {
  it('caregiver cannot approve or decline; other patient cannot respond', async () => {
    await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
    await expect(respond(C1, l._id, true)).rejects.toThrow('Only the patient');
    await expect(respond(P2, l._id, true)).rejects.toThrow('No pending');
    await expect(respond(P2, l._id, false)).rejects.toThrow('No pending');
    expect(has(C1, P1)).toBe(false);
  });
  it('unrelated patient or caregiver cannot revoke', async () => {
    await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
    await respond(P1, l._id, true);
    await expect(revoke(P2, l._id)).rejects.toThrow('No such link');
    await expect(revoke(C2, l._id)).rejects.toThrow('No such link');
    expect(has(C1, P1)).toBe(true);
  });
  it('cannot respond to a link already decided; malformed ids rejected', async () => {
    await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
    await respond(P1, l._id, false);
    await expect(respond(P1, l._id, true)).rejects.toThrow('No pending');
    expect(has(C1, P1)).toBe(false);
    await expect(respond(P1, 'bad', true)).rejects.toThrow('Invalid');
    await expect(revoke(P1, { $ne: 1 })).rejects.toThrow('Invalid');
  });
  it('lists are role-scoped and expose names only', async () => {
    await requestLink(C1, 'p1@x.com');
    await expect(listIncoming(C1)).rejects.toThrow('Only patients');
    await expect(listOutgoing(P1)).rejects.toThrow('Only caregivers');
    const rows = await listIncoming(P1);
    expect(rows).toEqual([expect.objectContaining({ caregiverName: 'Maya', status: 'pending' })]);
    expect(JSON.stringify(rows)).not.toContain('@');
    expect(await listIncoming(P2)).toEqual([]);
  });
});

describe('concurrency', () => {
  it('double approve and approve-vs-decline resolve to one outcome', async () => {
    await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
    const r = await Promise.allSettled([respond(P1, l._id, true), respond(P1, l._id, true), respond(P1, l._id, false)]);
    expect(r.filter(x => x.status === 'fulfilled').length).toBe(1);
    const final = (await db.CareLink.findOne({ _id: l._id })).status;
    expect(has(C1, P1)).toBe(final === 'active');
  });
  it('approve racing revoke never leaves access after revoke', async () => {
    for (let i = 0; i < 20; i++) {
      db.state.links = []; C1.linkedPatientIds = [];
      await requestLink(C1, 'p1@x.com'); const l = await only(C1, P1);
      await Promise.allSettled([respond(P1, l._id, true), revoke(C1, l._id), revoke(P1, l._id)]);
      const final = (await db.CareLink.findOne({ _id: l._id })).status;
      expect(has(C1, P1)).toBe(final === 'active');
    }
  });
});

describe('multiple caregivers and primary/secondary', () => {
  it('several caregivers can be active; revoking one leaves the others', async () => {
    await requestLink(C1, 'p1@x.com'); await requestLink(C2, 'p1@x.com');
    const a = await only(C1, P1), b = await only(C2, P1);
    await respond(P1, a._id, true, 'primary'); await respond(P1, b._id, true, 'secondary');
    expect(has(C1, P1) && has(C2, P1)).toBe(true);
    await revoke(P1, a._id);
    expect(has(C1, P1)).toBe(false); expect(has(C2, P1)).toBe(true);
  });
  it('a second active primary is refused and the link stays pending with no access', async () => {
    await requestLink(C1, 'p1@x.com'); await requestLink(C2, 'p1@x.com');
    const a = await only(C1, P1), b = await only(C2, P1);
    await respond(P1, a._id, true, 'primary');
    await expect(respond(P1, b._id, true, 'primary')).rejects.toThrow('already has an active primary');
    expect((await only(C2, P1)).status).toBe('pending');
    expect(has(C2, P1)).toBe(false);
    await respond(P1, b._id, true, 'secondary');
    expect(has(C2, P1)).toBe(true);
  });
  it('concurrent primary approvals: exactly one wins', async () => {
    await requestLink(C1, 'p1@x.com'); await requestLink(C2, 'p1@x.com');
    const a = await only(C1, P1), b = await only(C2, P1);
    const r = await Promise.allSettled([respond(P1, a._id, true, 'primary'), respond(P1, b._id, true, 'primary')]);
    expect(r.filter(x => x.status === 'fulfilled').length).toBe(1);
    expect([has(C1, P1), has(C2, P1)].filter(Boolean).length).toBe(1);
  });
  it('same caregiver, two patients: links are independent', async () => {
    await requestLink(C1, 'p1@x.com'); await requestLink(C1, 'p2@x.com');
    await respond(P1, (await only(C1, P1))._id, true);
    expect(has(C1, P1)).toBe(true); expect(has(C1, P2)).toBe(false);
  });
});

describe('seeded / legacy links', () => {
  it('are adopted as active, visible and revocable by the patient; no new access', async () => {
    C1.linkedPatientIds = [P1._id]; // seeded directly, no CareLink record
    expect(has(C1, P2)).toBe(false);
    const rows: any[] = await listIncoming(P1);
    expect(rows).toEqual([expect.objectContaining({ caregiverName: 'Maya', status: 'active', legacy: true })]);
    expect(has(C1, P1)).toBe(true);
    expect((await listIncoming(P1)).length).toBe(1); // idempotent
    await revoke(P1, rows[0].id);
    expect(has(C1, P1)).toBe(false);
  });
  it('legacy caregiver cannot create a duplicate pending request', async () => {
    C1.linkedPatientIds = [P1._id];
    await requestLink(C1, 'p1@x.com');
    expect(db.state.links.length).toBe(0);
  });
});
