import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Boots the real app in LOCATION_TEST_MODE against a real mongod and calls it over HTTP.
let mongod: MongoMemoryServer, server: http.Server, base = '';
const call = async (path: string, init: any = {}) => {
  const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  let body: any = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
};
const boot = async (env: Record<string, string | undefined>) => {
  vi.resetModules(); for (const m of mongoose.modelNames()) mongoose.deleteModel(m);
  for (const k of ['LOCATION_TEST_MODE', 'JWT_SECRET', 'MONGO_URI', 'LOCATION_FEATURE_ENABLED']) delete process.env[k];
  Object.assign(process.env, env);
  const app = (await import('../src/app')).default;
  server?.close(); await new Promise<void>(r => { server = http.createServer(app).listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
};
beforeAll(async () => { mongod = await MongoMemoryServer.create(); }, 120_000);
afterAll(async () => { server?.close(); await mongoose.disconnect(); await mongod.stop(); });

describe('LOCATION_TEST_MODE host', () => {
  it('fails closed when not fully configured', async () => {
    await boot({ LOCATION_TEST_MODE: 'true' });
    expect((await call('/api/auth/login', { method: 'POST', body: '{}' })).status).toBe(503);
    await boot({ LOCATION_TEST_MODE: 'true', JWT_SECRET: 'x'.repeat(32), MONGO_URI: mongod.getUri() });   // feature flag missing
    expect((await call('/api/care-links/incoming')).status).toBe(503);
  });
  it('serves only auth, care-links and location; everything else is 404', async () => {
    await boot({ LOCATION_TEST_MODE: 'true', JWT_SECRET: 'x'.repeat(32), MONGO_URI: mongod.getUri(), LOCATION_FEATURE_ENABLED: 'true' });
    expect((await call('/health')).body.mode).toBe('location-test');
    for (const p of ['/api/chat', '/api/events', '/api/media', '/api/caregiver/patient/abc/profile', '/api/patient/profile', '/api/conversation', '/api/elevenlabs', '/queues'])
      expect((await call(p)).status, p).toBe(404);
  });
  it('requires authentication on care-link and location routes', async () => {
    for (const p of ['/api/care-links/incoming', '/api/caregiver/patients', '/api/location/status', '/api/location/live/abc', '/api/location/zone/abc', '/api/location/diagnostics/device', '/api/location/diagnostics/boundary/abc'])
      expect((await call(p)).status, p).toBe(401);
    expect((await call('/api/location/status', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });
  it('uses its own fixed database name, not the one in the URI', async () => {
    expect(mongoose.connection.name).toBe('alzhefi_location_test');
  });
  it('end to end over HTTP: register, link, approve, opt in, set zone, fix, live', async () => {
    const reg = async (name: string, role: string) => (await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email: `${name}@t.test`, password: 'synthetic-pass-1', role }) })).body;
    const P = await reg('pat', 'patient'), C = await reg('car', 'caregiver'), Other = await reg('other', 'caregiver');
    const auth = (u: any) => ({ authorization: `Bearer ${u.token}` });
    expect(P.token && C.token).toBeTruthy();
    expect((await call('/api/care-links/request', { method: 'POST', headers: auth(C), body: JSON.stringify({ email: 'pat@t.test' }) })).status).toBe(200);
    const inc = (await call('/api/care-links/incoming', { headers: auth(P) })).body;
    expect((await call(`/api/care-links/${inc[0].id}/approve`, { method: 'POST', headers: auth(P), body: JSON.stringify({ role: 'primary' }) })).status).toBe(200);
    const pid = (await call('/api/location/status', { headers: auth(C) })).body.patients[0].patientId;
    expect((await call(`/api/location/zone/${pid}`, { method: 'PUT', headers: auth(C), body: JSON.stringify({ lat: 10, lon: 76, radiusM: 300 }) })).status).toBe(403);  // no patient opt-in yet
    await call('/api/location/grants', { method: 'POST', headers: auth(P), body: JSON.stringify({ caregiverId: (await call('/api/location/status', { headers: auth(P) })).body.caregivers[0].caregiverId }) });
    expect((await call(`/api/location/zone/${pid}`, { method: 'PUT', headers: auth(C), body: JSON.stringify({ lat: 10, lon: 76, radiusM: 300 }) })).status).toBe(200);
    expect((await call('/api/location/fix', { method: 'POST', headers: auth(P), body: JSON.stringify({ lat: 10, lon: 76, accuracyM: 10, recordedAt: Date.now() }) })).status).toBe(200);
    const live = (await call(`/api/location/live/${pid}`, { headers: auth(C) })).body;
    expect(live.status).toBe('live');
    const diag = await call(`/api/location/diagnostics/boundary/${pid}`, { headers: auth(C) });
    expect(diag.status).toBe(200); expect(diag.body.position).toBe('inside');
    expect(JSON.stringify(diag.body)).not.toMatch(/lat|lon|token|patientName/i);
    expect((await call(`/api/location/diagnostics/boundary/${pid}`, { headers: auth(Other) })).status).toBe(403);
    expect((await call(`/api/location/diagnostics/boundary/${pid}`, { headers: auth(P) })).status).toBe(403);
    const devices = await call('/api/location/diagnostics/device', { headers: auth(C) });
    expect(devices.body).toEqual({ registeredDevices: 0 });
    await call('/api/location/sharing/off', { method: 'POST', headers: auth(P) });
    expect((await call(`/api/location/live/${pid}`, { headers: auth(C) })).status).toBe(403);
    expect((await call(`/api/location/diagnostics/boundary/${pid}`, { headers: auth(C) })).status).toBe(403);
    const dbs = (await mongoose.connection.getClient().db().admin().listDatabases()).databases.map(d => d.name);
    expect(dbs).toContain('alzhefi_location_test');
    expect(dbs).not.toContain('test');                                    // nothing written to the URI's default database
  });
});
