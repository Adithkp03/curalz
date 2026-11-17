import {timingSafeEqual} from 'node:crypto';
import CareLink from '../models/CareLink';
import {MedicationDose,MedicationFollowup,MedicationGrant,MedicationPlan,MedicationPreferences} from './models';
import {followupConfigured,listMedication} from './service';
import {makeFcmSender,type CareSender} from '../location/fcmSender';
import {DeviceToken} from '../models/LocationModels';
export function cronAuthorized(header:unknown){const secret=process.env.MEDICATION_CRON_SECRET;if(process.env.LOCATION_TEST_MODE!=='true'||!secret||secret.length<32||typeof header!=='string')return false;const expected=Buffer.from('Bearer '+secret),actual=Buffer.from(header);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
/** Request-driven until an independently approved scheduler is configured. No timers on a serverless host. */
export async function sweepMedication(send:CareSender|null=makeFcmSender(),now=Date.now(),onlyPatient?:string){
 if(!followupConfigured()||!send)return {enabled:false,attempted:0};
 const prefs:any[]=await MedicationPreferences.find({followupOn:true,...(onlyPatient?{patientId:onlyPatient}:{})}).limit(100);let attempted=0;
 for(const pref of prefs){
  // Materialize schedules with the patient's own scope, never borrowing a caregiver's permission.
  await listMedication({_id:pref.patientId,role:'patient'},String(pref.patientId),now);
  const primary:any=await CareLink.findOne({patientId:pref.patientId,status:'active',role:'primary'});if(!primary)continue;
  const grant=await MedicationGrant.exists({patientId:pref.patientId,caregiverId:primary.caregiverId,linkId:primary._id,active:true});if(!grant)continue;
  const due:any[]=await MedicationDose.find({patientId:pref.patientId,state:'not_confirmed',dueAt:{$lte:new Date(now-pref.graceMinutes*60000),$gte:new Date(Math.max(now-6*3600000,Number(pref.updatedAt)))}}).sort({dueAt:1}).limit(50);
  for(const dose of due){
   try{await MedicationFollowup.updateOne({doseId:dose._id},{$setOnInsert:{patientId:pref.patientId,caregiverId:primary.caregiverId,linkId:primary._id,status:'queued'}},{upsert:true});}catch(e:any){if(e.code!==11000)throw e;}
   const record:any=await MedicationFollowup.findOne({doseId:dose._id,status:'queued'});if(!record)continue;
   const [stillLinked,stillShared,currentPrefs,currentDose,plan]=await Promise.all([CareLink.exists({_id:record.linkId,status:'active',role:'primary'}),MedicationGrant.exists({patientId:pref.patientId,caregiverId:record.caregiverId,linkId:record.linkId,active:true}),MedicationPreferences.findOne({patientId:pref.patientId,followupOn:true}),MedicationDose.findById(dose._id),MedicationPlan.findById(dose.planId)]);
   if(!stillLinked||!stillShared||!currentPrefs||currentDose?.state!=='not_confirmed'||!plan?.active){await MedicationFollowup.updateOne({_id:record._id,status:'queued'},{$set:{status:'cancelled',reason:'eligibility_changed'}});continue;}
   if(now-currentDose.dueAt.getTime()<currentPrefs.graceMinutes*60000)continue;
   if(!await DeviceToken.exists({userId:record.caregiverId}))continue; // definitely before provider: retry on next eligible sweep
   const claim:any=await MedicationFollowup.findOneAndUpdate({_id:record._id,status:'queued'},{$set:{status:'processing',attemptedAt:new Date(now)}},{returnDocument:'after'});if(!claim)continue;
   attempted++;try{const result=await send({userId:String(record.caregiverId),kind:'medication_followup',title:'Dose not confirmed',body:'A scheduled dose has no current report. Open Alzhefi and check with the patient. Do not advise an extra dose.',data:{patientId:String(pref.patientId),eventId:String(record._id)}});await MedicationFollowup.updateOne({_id:record._id},{$set:{status:result==='sent'?'provider_accepted':'failed',reason:result==='sent'?'provider_acceptance_not_delivery':'not_sent'}});}catch{await MedicationFollowup.updateOne({_id:record._id},{$set:{status:'failed',reason:'provider_result_uncertain_no_auto_retry'}});}
  }
 }
 return {enabled:true,attempted};
}
