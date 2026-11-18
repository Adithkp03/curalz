/** UNWIRED health-state preparation. Threshold intentionally required,not selected. */
export type Health = { consentSession: string; startedAt: number; lastFreshReceivedAt?: number; lastFixRecordedAt?: number; unavailableEpisodeAt?: number };
export type Sample = { receivedAt: number; recordedAt: number; validCoordinates: boolean; accuracyM: number };
export function accept(s:Health,sample:Sample,maxAgeMs:number):Health {
 if(!sample.validCoordinates || !Number.isFinite(sample.recordedAt) || !Number.isFinite(sample.receivedAt) || !Number.isFinite(sample.accuracyM) || sample.accuracyM<0 || sample.recordedAt>sample.receivedAt+30000 || sample.receivedAt-sample.recordedAt>maxAgeMs || sample.receivedAt<s.startedAt || (s.lastFixRecordedAt!==undefined&&sample.recordedAt<=s.lastFixRecordedAt))return s;
 return {...s,lastFreshReceivedAt:sample.receivedAt,lastFixRecordedAt:sample.recordedAt,unavailableEpisodeAt:undefined};
}
export function check(s:Health,now:number,thresholdMs:number,currentConsentSession:string|null):'cancel'|'healthy'|'wait'|'already_open'|'open_unavailable' {
 if(currentConsentSession!==s.consentSession)return 'cancel';
 if(!Number.isFinite(thresholdMs)||thresholdMs<=0)throw Error('Explicit positive threshold required');
 if(s.unavailableEpisodeAt!==undefined)return 'already_open';
 const last=s.lastFreshReceivedAt??s.startedAt;
 return now-last>=thresholdMs?'open_unavailable':s.lastFreshReceivedAt===undefined?'wait':'healthy';
}
