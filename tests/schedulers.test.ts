import {describe,it,expect,vi} from 'vitest';
import locationWorker from '../location-scheduler/worker';
import medicationWorker from '../medication-scheduler/worker';
for (const [name,worker,key,path] of [
 ['location',locationWorker,'LOCATION_SWEEP_KEY','location-health'],
 ['medication',medicationWorker,'MEDICATION_SWEEP_KEY','medication'],
] as const) {
 describe(name+' Cloudflare scheduler',()=>{
  for(const status of [200,302,401,500])it('handles HTTP '+status+' without following redirects',async()=>{
   const cancel=vi.fn().mockResolvedValue(undefined);
   const fetchMock=vi.fn().mockImplementation(async (_url:string,init:RequestInit)=>{
    if(init.redirect!=='manual')throw new TypeError('Cloudflare supports manual or follow only');
    return {ok:status>=200&&status<300,status,body:{cancel}};
   });
   vi.stubGlobal('fetch',fetchMock);
   try {
    const result=worker.scheduled({}, {[key]:'x'.repeat(48)} as any);
    if(status===200)await expect(result).resolves.toBeUndefined();else await expect(result).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url,init]=fetchMock.mock.calls[0];
    expect(url).toBe('https://alzhefi-location-test.vercel.app/api/'+path+'/jobs/sweep');
    expect(init.redirect).toBe('manual');expect(init.method).toBe('POST');
    expect(cancel).toHaveBeenCalledTimes(status===200?1:0);
   } finally {vi.unstubAllGlobals();}
  });
  it('fails closed without a configured key',async()=>{
   const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
   try{await expect(worker.scheduled({},{} as any)).rejects.toThrow();expect(fetchMock).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
  });
 });
}
