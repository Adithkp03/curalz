// Boundary-repeat isolated checker. No public fetch endpoint, no coordinates, identifiers or response-body logging.
interface Env { BOUNDARY_REPEAT_SWEEP_KEY: string }
export default {
 async scheduled(_event: unknown, env: Env): Promise<void> {
  if (!env.BOUNDARY_REPEAT_SWEEP_KEY || env.BOUNDARY_REPEAT_SWEEP_KEY.length < 32) throw Error('Boundary repeat checker is not configured');
  const response = await fetch('https://alzhefi-location-test.vercel.app/api/location/boundary-repeat/jobs/sweep', { method: 'POST', headers: { Authorization: 'Bearer ' + env.BOUNDARY_REPEAT_SWEEP_KEY }, signal: AbortSignal.timeout(25000), redirect: 'manual' });
  if (!response.ok) throw Error('Boundary repeat checker did not complete');
  await response.body?.cancel();
 }
};
