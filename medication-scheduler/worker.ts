// Preparation only. Deployment/account resource and cron require explicit approval.
// No public fetch handler; no medical data is requested or stored here.
interface Env { MEDICATION_SWEEP_KEY: string }
export default {
 async scheduled(_event:unknown,env:Env):Promise<void>{
  if(!env.MEDICATION_SWEEP_KEY||env.MEDICATION_SWEEP_KEY.length<32)throw new Error('Scheduler is not configured');
  const response=await fetch('https://alzhefi-location-test.vercel.app/api/medication/jobs/sweep',{
   method:'POST',headers:{Authorization:'Bearer '+env.MEDICATION_SWEEP_KEY},signal:AbortSignal.timeout(25000),redirect:'manual'
  });
  // Never log response bodies,private identifiers,headers or credentials.
  if(!response.ok)throw new Error('Medication sweep did not complete');
  await response.body?.cancel();
 }
};
