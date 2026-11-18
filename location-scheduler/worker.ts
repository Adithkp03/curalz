// Location-only isolated checker. No public fetch endpoint,no coordinates,identifiers or response-body logging.
interface Env { LOCATION_SWEEP_KEY:string }
export default {
 async scheduled(_event:unknown,env:Env):Promise<void>{
  if(!env.LOCATION_SWEEP_KEY||env.LOCATION_SWEEP_KEY.length<32)throw Error('Location checker is not configured');
  const response=await fetch('https://alzhefi-location-test.vercel.app/api/location-health/jobs/sweep',{method:'POST',headers:{Authorization:'Bearer '+env.LOCATION_SWEEP_KEY},signal:AbortSignal.timeout(25000),redirect:'manual'});
  if(!response.ok)throw Error('Location checker did not complete');await response.body?.cancel();
 }
};
