import {it,expect,describe} from 'vitest';
import {accept,check,Health,Sample} from '../proposals/location-health-policy';
const T=1800000000000,M=60000;
const h=():Health=>({consentSession:'synthetic-link-and-grant',startedAt:T});
const sample=(delta=0):Sample=>({receivedAt:T+delta,recordedAt:T+delta,validCoordinates:true,accuracyM:10});
describe('unwired location-health semantics; five minutes is test input,not configured policy',()=>{
 it('waits from consent-start when no first fix,then opens one episode',()=>{expect(check(h(),T+5*M-1,5*M,h().consentSession)).toBe('wait');expect(check(h(),T+5*M,5*M,h().consentSession)).toBe('open_unavailable');expect(check({...h(),unavailableEpisodeAt:T+5*M},T+90*M,5*M,h().consentSession)).toBe('already_open');});
 it('cancelled consent/revoke/replaced link cannot alert or revive old episode',()=>{for(const session of [null,'new-grant'])expect(check({...h(),unavailableEpisodeAt:T},T+10*M,5*M,session)).toBe('cancel');});
 it('fresh recovery clears outage and restarts freshness window',()=>{const s=accept({...h(),unavailableEpisodeAt:T+5*M},sample(6*M),5*M);expect(s.unavailableEpisodeAt).toBeUndefined();expect(check(s,T+10*M,5*M,s.consentSession)).toBe('healthy');expect(check(s,T+11*M,5*M,s.consentSession)).toBe('open_unavailable');});
 it('stale cached,future,invalid or malformed fixes cannot fake recovery',()=>{const s={...h(),unavailableEpisodeAt:T+5*M};for(const patch of [{recordedAt:T},{recordedAt:T+20*M},{validCoordinates:false},{accuracyM:NaN},{recordedAt:NaN}])expect(accept(s,{...sample(6*M),...patch},5*M)).toEqual(s);});
 it('server receipt of a repeated old timestamp does not keep resetting freshness',()=>{const s=accept(h(),sample(M),5*M);expect(accept(s,{...sample(4*M),recordedAt:T+M},5*M)).toEqual(s);});
 it('accuracy alone is not equivalent to updates stopped',()=>{const s=accept(h(),{...sample(M),accuracyM:500},5*M);expect(s.lastFreshReceivedAt).toBe(T+M);expect(check(s,T+2*M,5*M,s.consentSession)).toBe('healthy');});
 it('requires a positive explicit threshold',()=>{expect(()=>check(h(),T,0,h().consentSession)).toThrow();});
});
