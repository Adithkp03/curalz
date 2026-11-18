import mongoose,{Schema} from 'mongoose';
import {timingSafeEqual} from 'node:crypto';
import CareLink from '../models/CareLink';
import LocationGrant from '../models/LocationGrant';
import {DeviceToken} from '../models/LocationModels';
import {isValidFix,Fix} from '../location/evaluate';
import {LinkError} from '../services/careLink.service';
import {makeFcmSender,CareSender} from '../location/fcmSender';
export const HEALTH_THRESHOLD_MS=120000;
const sessionSchema=new Schema({patientId:{type:Schema.Types.ObjectId,required:true},caregiverId:{type:Schema.Types.ObjectId,required:true},linkId:{type:Schema.Types.ObjectId,required:true},grantId:{type:Schema.Types.ObjectId,required:true},startedAt:{type:Number,required:true},lastFreshAt:Number,lastRecordedAt:Number,outageId:String,attemptedOutageId:String,rev:{type:Number,default:0}},{timestamps:true});
sessionSchema.index({linkId:1,grantId:1},{unique:true});
export const LocationHealthSession=mongoose.model('LocationHealthSession',sessionSchema);
const eventSchema=new Schema({sessionId:{type:Schema.Types.ObjectId,required:true},outageId:{type:String,required:true},userId:{type:Schema.Types.ObjectId,required:true},patientId:{type:Schema.Types.ObjectId,required:true},occurredAt:{type:Number,required:true},lastFreshAt:Number,status:{type:String,enum:['pending','processing','sent','logged','failed','cancelled'],default:'pending'},reason:String},{timestamps:true});
eventSchema.index({sessionId:1,outageId:1},{unique:true});eventSchema.index({createdAt:1},{expireAfterSeconds:86400});
export const LocationHealthEvent=mongoose.model('LocationHealthEvent',eventSchema);
export const healthEnabled=()=>process.env.LOCATION_TEST_MODE==='true'&&process.env.LOCATION_FEATURE_ENABLED==='true'&&process.env.LOCATION_HEALTH_ENABLED==='true';
export const healthSchedulerActive=()=>healthEnabled()&&process.env.LOCATION_HEALTH_SCHEDULER_ACTIVE==='true';
export function locationCronAuthorized(header:unknown){const key=process.env.LOCATION_CRON_SECRET;if(!healthEnabled()||!key||key.length<32||typeof header!=='string')return false;const a=Buffer.from(header),b=Buffer.from('Bearer '+key);return a.length===b.length&&timingSafeEqual(a,b);}
async function current(s:any){return !!(await CareLink.exists({_id:s.linkId,patientId:s.patientId,caregiverId:s.caregiverId,status:'active'})&&await LocationGrant.exists({_id:s.grantId,patientId:s.patientId,caregiverId:s.caregiverId,status:'active'}));}
/** Only metadata,no coordinates. Old grants receive a fresh grace period when this module first activates. */
export async function ensureHealthSessions(patientId?:any,now=Date.now()){
 if(!healthEnabled())return;await LocationHealthSession.init();
 const grants:any[]=await LocationGrant.find({status:'active',...(patientId?{patientId}:{})}).limit(1001);if(grants.length>1000)throw Error('Health enrollment batch limit');
 for(const g of grants){const link:any=await CareLink.findOne({patientId:g.patientId,caregiverId:g.caregiverId,status:'active'});if(!link)continue;
 await LocationHealthSession.updateOne({linkId:link._id,grantId:g._id},{$setOnInsert:{patientId:g.patientId,caregiverId:g.caregiverId,linkId:link._id,grantId:g._id,startedAt:now,rev:0}},{upsert:true});}
}
export async function recordHealthFix(patientId:any,fix:Fix,now=Date.now()){
 if(!healthEnabled()||!isValidFix(fix)||fix.recordedAt>now+30000||now-fix.recordedAt>HEALTH_THRESHOLD_MS)return;
 await ensureHealthSessions(patientId,now);
 const sessions:any[]=await LocationHealthSession.find({patientId});
 for(const s of sessions){if(!await current(s)||fix.recordedAt<s.startedAt||s.lastRecordedAt!==undefined&&fix.recordedAt<=s.lastRecordedAt)continue;
 const won=await LocationHealthSession.updateOne({_id:s._id,rev:s.rev},{$set:{lastFreshAt:Math.min(now,fix.recordedAt),lastRecordedAt:fix.recordedAt},$unset:{outageId:1},$inc:{rev:1}});
 if(won.modifiedCount)await LocationHealthEvent.updateMany({sessionId:s._id,status:'pending'},{$set:{status:'cancelled',reason:'fresh location resumed'}});}
}
export async function healthForCaregiver(actor:any,patientId:string,now=Date.now()){
 if(!healthEnabled()||actor.role!=='caregiver'||!mongoose.isValidObjectId(patientId))throw new LinkError(404,'Location health unavailable');
 const sessions:any[]=await LocationHealthSession.find({patientId,caregiverId:actor._id}).sort({startedAt:-1});
 const s=(await Promise.all(sessions.map(async x=>await current(x)?x:null))).find(Boolean);if(!s)throw new LinkError(403,'Location sharing unavailable');
 const last=s.lastFreshAt??s.startedAt;return {status:now-last>=HEALTH_THRESHOLD_MS?'unavailable':s.lastFreshAt===undefined?'waiting':'receiving',lastFreshAt:s.lastFreshAt??null,sharingStartedAt:s.startedAt,thresholdMs:HEALTH_THRESHOLD_MS,schedulerActive:healthSchedulerActive()};
}
async function eventAccess(e:any,now:number){if(!e||now-e.occurredAt>300000||e.occurredAt>now+30000)return null;const s:any=await LocationHealthSession.findById(e.sessionId);return s&&s.outageId===e.outageId&&await current(s)&&now-(s.lastFreshAt??s.startedAt)>=HEALTH_THRESHOLD_MS?s:null;}
export async function readHealthEvent(actor:any,id:string,now=Date.now()){
 if(!healthEnabled()||actor.role!=='caregiver'||!mongoose.isValidObjectId(id))throw new LinkError(404,'Alert unavailable');const e:any=await LocationHealthEvent.findOne({_id:id,userId:actor._id,status:{$in:['processing','sent']}});if(!await eventAccess(e,now))throw new LinkError(404,'Alert no longer current');
 return {eventId:String(e._id),patientId:String(e.patientId),recipientId:String(e.userId),occurredAt:e.occurredAt,lastFreshAt:e.lastFreshAt??null};
}
export async function sweepLocationHealth(send:CareSender|null=makeFcmSender(),now=Date.now()){
 if(!healthEnabled())return {enabled:false};await ensureHealthSessions(undefined,now);await LocationHealthEvent.init();
 const result={enabled:true,checked:0,sent:0,failed:0,cancelled:0,waitingForDevice:0};
 const sessions:any[]=await LocationHealthSession.find().limit(1001);if(sessions.length>1000)throw Error('Health sweep batch limit');
 for(const s of sessions){result.checked++;
 if(!await current(s)){await LocationHealthEvent.updateMany({sessionId:s._id,status:'pending'},{$set:{status:'cancelled',reason:'access ended'}});await LocationHealthSession.deleteOne({_id:s._id});continue;}
 if(now-(s.lastFreshAt??s.startedAt)<HEALTH_THRESHOLD_MS)continue;
 let outage=s.outageId;if(!outage){outage=String(new mongoose.Types.ObjectId());const won=await LocationHealthSession.updateOne({_id:s._id,rev:s.rev,outageId:{$exists:false}},{$set:{outageId:outage},$inc:{rev:1}});if(!won.modifiedCount)continue;}
 const e:any=await LocationHealthEvent.findOneAndUpdate({sessionId:s._id,outageId:outage},{$setOnInsert:{sessionId:s._id,outageId:outage,userId:s.caregiverId,patientId:s.patientId,occurredAt:now,lastFreshAt:s.lastFreshAt,status:'pending'}},{upsert:true,new:true});
 if(e.status!=='pending'||s.attemptedOutageId===outage)continue;
 if(!await eventAccess(e,now)){await LocationHealthEvent.updateOne({_id:e._id,status:'pending'},{$set:{status:'cancelled',reason:'no longer current'}});result.cancelled++;continue;}
 if(!send||!await DeviceToken.exists({userId:s.caregiverId,locationHealthV1:true})){result.waitingForDevice++;continue;}
 const won=await LocationHealthEvent.findOneAndUpdate({_id:e._id,status:'pending'},{$set:{status:'processing'}});if(!won)continue;
 await LocationHealthSession.updateOne({_id:s._id,outageId:outage},{$set:{attemptedOutageId:outage}});
 // Revalidate after atomic claim. Provider ambiguity is not replayed.
 if(!await eventAccess(e,now)){await LocationHealthEvent.updateOne({_id:e._id},{$set:{status:'cancelled',reason:'no longer current'}});result.cancelled++;continue;}
 try{const state=await send({userId:String(s.caregiverId),kind:'location_unavailable',title:'Location updates stopped',body:'Open AlzheFi to check the last update time. This is not a boundary alert.',data:{patientId:String(s.patientId),eventId:String(e._id)}});await LocationHealthEvent.updateOne({_id:e._id},{$set:{status:state}});if(state==='sent')result.sent++;}
 catch{await LocationHealthEvent.updateOne({_id:e._id},{$set:{status:'failed',reason:'provider attempt did not complete'}});result.failed++;}
 }
 return result;
}
