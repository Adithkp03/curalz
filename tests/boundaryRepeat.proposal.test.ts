import { describe,it,expect } from 'vitest';
import { due,claim,stop,closeFromEvidence,Episode,Evidence,Policy } from '../proposals/boundary-repeat-policy';
const T=1_800_000_000_000;
const ep=():Episode=>({id:'synthetic-episode',openedAt:T,stoppedBy:[],lastAttemptAt:{}});
const ev:Evidence={currentAccess:true,sameOriginalLinkAndGrant:true,sameZone:true,fresh:true,clearlyInside:false,outside:true};
// These policies exercise both unresolved owner choices. They are NOT selected defaults.
const policies:Policy[]=['caregiver','episode'].flatMap(stopScope=>['pause','unresolved_reminder'].flatMap(stale=>[true,false].map(stopOnReturn=>({stopScope,stale,stopOnReturn} as Policy))));
describe('unwired boundary-repeat policy preparation',()=>{
 for(const p of policies){
  const label=JSON.stringify(p);
  it('waits full ten minutes and never catches up in a burst '+label,()=>{
   let e=ep();expect(due(e,'a',ev,p,T+599999)).toBe('wait');expect(due(e,'a',ev,p,T+600000)).toBe('outside_reminder');
   e=claim(e,'a',T+3600000);expect(due(e,'a',ev,p,T+3600001)).toBe('wait');expect(due(e,'a',ev,p,T+4200000)).toBe('outside_reminder');
  });
  it('always suppresses revoked access,changed grant/link and zone '+label,()=>{
   for(const key of ['currentAccess','sameOriginalLinkAndGrant','sameZone'])expect(due(ep(),'a',{...ev,[key]:false},p,T+600000)).toBe('suppressed');
  });
  it('implements explicit stop scope,idempotently and without affecting a future episode '+label,()=>{
   const a=stop(ep(),'a',p);expect(stop(a,'a',p)).toEqual(a);expect(due(a,'a',ev,p,T+600000)).toBe('suppressed');
   expect(due(a,'b',ev,p,T+600000)).toBe(p.stopScope==='episode'?'suppressed':'outside_reminder');
   expect(due(ep(),'a',ev,p,T+600000)).toBe('outside_reminder');
  });
  it('never claims outside on stale/uncertain evidence '+label,()=>{
   for(const e of [{...ev,fresh:false},{...ev,outside:false}])expect(due(ep(),'a',e,p,T+600000)).toBe(p.stale==='pause'?'suppressed':'unresolved_reminder');
  });
  it('only fresh clearly-inside evidence can apply the chosen return policy '+label,()=>{
   expect(closeFromEvidence(ep(),{...ev,fresh:false,clearlyInside:true},p).closed).toBeUndefined();
   expect(closeFromEvidence(ep(),{...ev,clearlyInside:true,outside:false},p).closed).toBe(p.stopOnReturn?'returned':undefined);
   const closed=closeFromEvidence(ep(),{...ev,sameZone:false},p);expect(closed.closed).toBe('zone_changed');expect(due(closed,'a',ev,p,T+600000)).toBe('suppressed');
  });
 }
});
