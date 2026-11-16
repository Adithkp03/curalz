import { describe, it, expect, vi, beforeEach } from 'vitest';
const db = vi.hoisted(() => {
  const st: any = { links: [], grants: [] };
  const m = (d: any, f: any) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v));
  return { st,
    CareLink: { findOne: async (f: any) => st.links.find((l: any) => m(l, f)) ?? null },
    LocationGrant: {
      findOne: async (f: any) => st.grants.find((g: any) => m(g, f)) ?? null,
      create: async (d: any) => { if (st.grants.some((g: any) => g.status === 'active' && g.patientId === d.patientId && g.caregiverId === d.caregiverId)) throw Object.assign(new Error('d'), { code: 'DUP' }); st.grants.push({ ...d }); },
      findOneAndUpdate: async (f: any, u: any) => { const g = st.grants.find((x: any) => m(x, f)); if (g) Object.assign(g, u.$set); return g ?? null; },
    } };
});
vi.mock('../src/models/CareLink', () => ({ default: db.CareLink }));
vi.mock('../src/models/LocationGrant', () => ({ default: db.LocationGrant }));
vi.mock('../src/models/User', () => ({ default: {} }));
import { grantLocation, revokeLocation, hasLocationAuthority } from '../src/services/locationAuthority.service';

const P = { _id: 'p1', role: 'patient' }, C = { _id: 'c1', role: 'caregiver' };
beforeEach(() => { db.st.links = []; db.st.grants = []; });

describe('location authority is separate from linking', () => {
  it('an active link alone (including legacy) gives no location authority', async () => {
    db.st.links.push({ patientId: 'p1', caregiverId: 'c1', status: 'active', legacy: true });
    expect(await hasLocationAuthority('c1', 'p1')).toBe(false);
  });
  it('needs an explicit patient grant on top of an active link', async () => {
    db.st.links.push({ patientId: 'p1', caregiverId: 'c1', status: 'active' });
    await grantLocation(P, 'c1');
    expect(await hasLocationAuthority('c1', 'p1')).toBe(true);
  });
  it('cannot grant without an active link, pending link, or as a caregiver', async () => {
    await expect(grantLocation(P, 'c1')).rejects.toThrow('No active caregiver link');
    db.st.links.push({ patientId: 'p1', caregiverId: 'c1', status: 'pending' });
    await expect(grantLocation(P, 'c1')).rejects.toThrow('No active caregiver link');
    await expect(grantLocation(C, 'c1')).rejects.toThrow('Only the patient');
  });
  it('revoking the link removes authority even though the grant record remains', async () => {
    db.st.links.push({ patientId: 'p1', caregiverId: 'c1', status: 'active' });
    await grantLocation(P, 'c1');
    db.st.links[0].status = 'revoked';
    expect(await hasLocationAuthority('c1', 'p1')).toBe(false);
  });
  it('either side can revoke the grant; strangers cannot', async () => {
    db.st.links.push({ patientId: 'p1', caregiverId: 'c1', status: 'active' });
    await grantLocation(P, 'c1');
    await expect(revokeLocation({ _id: 'x', role: 'caregiver' }, 'p1', 'c1')).rejects.toThrow('Not allowed');
    await expect(revokeLocation({ _id: 'p2', role: 'patient' }, 'p1', 'c1')).rejects.toThrow('Not allowed');
    await revokeLocation(C, 'p1', 'c1');
    expect(await hasLocationAuthority('c1', 'p1')).toBe(false);
  });
  it('granting twice is idempotent', async () => {
    db.st.links.push({ patientId: 'p1', caregiverId: 'c1', status: 'active' });
    await grantLocation(P, 'c1'); await grantLocation(P, 'c1');
    expect(db.st.grants.length).toBe(1);
  });
});
