import { describe, it, expect, vi, beforeEach } from 'vitest';
const m = vi.hoisted(() => ({
  userFindOne: vi.fn(), userFind: vi.fn(), userUpdate: vi.fn(),
  linkFindOne: vi.fn(), linkFind: vi.fn(), linkCreate: vi.fn(),
}));
vi.mock('../src/models/User', () => ({ default: { findOne: m.userFindOne, find: m.userFind, updateOne: m.userUpdate } }));
vi.mock('../src/models/CareLink', () => ({ default: { findOne: m.linkFindOne, find: m.linkFind, create: m.linkCreate } }));
import { requestLink, respond, revoke, listIncoming } from '../src/services/careLink.service';

const pat = { _id: 'p1', role: 'patient' };
const cg = { _id: 'c1', role: 'caregiver' };
const id = 'a'.repeat(24);
beforeEach(() => vi.clearAllMocks());

describe('patient-approved linking', () => {
  it('request creates only a pending link and grants nothing', async () => {
    m.userFindOne.mockResolvedValue(pat); m.linkFindOne.mockResolvedValue(null);
    await requestLink(cg, 'P@x.com');
    expect(m.linkCreate).toHaveBeenCalledWith({ patientId: 'p1', caregiverId: 'c1', status: 'pending' });
    expect(m.userUpdate).not.toHaveBeenCalled();
  });
  it('gives the same answer whether or not the patient exists', async () => {
    m.userFindOne.mockResolvedValue(null);
    const a = await requestLink(cg, 'no@x.com');
    m.userFindOne.mockResolvedValue(pat); m.linkFindOne.mockResolvedValue(null);
    const b = await requestLink(cg, 'p@x.com');
    expect(a).toEqual(b);
  });
  it('does not duplicate an open request', async () => {
    m.userFindOne.mockResolvedValue(pat); m.linkFindOne.mockResolvedValue({ _id: 'x' });
    await requestLink(cg, 'p@x.com');
    expect(m.linkCreate).not.toHaveBeenCalled();
  });
  it('only caregivers request, only patients respond', async () => {
    await expect(requestLink(pat, 'a@b.c')).rejects.toThrow('Only caregivers');
    await expect(respond(cg, id, true)).rejects.toThrow('Only the patient');
  });
  it('approve activates and adds caregiver access; decline does not', async () => {
    const link: any = { status: 'pending', caregiverId: 'c1', patientId: 'p1', role: 'secondary', save: vi.fn() };
    m.linkFindOne.mockResolvedValue(link);
    const r: any = await respond(pat, id, true, 'primary');
    expect(r).toEqual({ status: 'active', role: 'primary' });
    expect(m.userUpdate).toHaveBeenCalledWith({ _id: 'c1' }, { $addToSet: { linkedPatientIds: 'p1' } });
    vi.clearAllMocks();
    const link2: any = { status: 'pending', caregiverId: 'c1', patientId: 'p1', save: vi.fn() };
    m.linkFindOne.mockResolvedValue(link2);
    expect(await respond(pat, id, false)).toEqual({ status: 'declined' });
    expect(m.userUpdate).not.toHaveBeenCalled();
  });
  it('cannot respond to another patient\'s or non-pending link', async () => {
    m.linkFindOne.mockResolvedValue(null);
    await expect(respond(pat, id, true)).rejects.toThrow('No pending');
    m.linkFindOne.mockResolvedValue({ status: 'active' });
    await expect(respond(pat, id, true)).rejects.toThrow('No pending');
    await expect(respond(pat, 'bad', true)).rejects.toThrow('Invalid');
  });
  it('either side can revoke and access is removed', async () => {
    const link: any = { caregiverId: 'c1', patientId: 'p1', save: vi.fn() };
    m.linkFindOne.mockResolvedValue(link);
    await revoke(cg, id);
    expect(link.status).toBe('revoked');
    expect(m.linkFindOne.mock.calls[0][0]).toMatchObject({ caregiverId: 'c1' });
    expect(m.userUpdate).toHaveBeenCalledWith({ _id: 'c1' }, { $pull: { linkedPatientIds: 'p1' } });
    m.linkFindOne.mockResolvedValue(null);
    await expect(revoke(pat, id)).rejects.toThrow('No such link');
  });
  it('incoming list shows names only', async () => {
    m.linkFind.mockResolvedValue([{ _id: 'l1', caregiverId: 'c1', role: 'secondary', status: 'pending' }]);
    m.userFind.mockReturnValue({ select: () => Promise.resolve([{ _id: 'c1', name: 'Maya' }]) });
    expect(await listIncoming(pat)).toEqual([{ id: 'l1', caregiverName: 'Maya', role: 'secondary', status: 'pending' }]);
  });
});
