import mongoose,{Schema} from 'mongoose';
import {DeviceToken} from '../models/LocationModels';
import {stepBoundary,initialBoundaryState} from '../location/evaluate';
import {PROPOSED_LOCATION_CONFIG as cfg} from '../location/config';
import {LinkError} from './careLink.service';
import {sendBoundaryTest} from '../location/fcmSender';
const schema=new Schema({userId:{type:Schema.Types.ObjectId,required:true},token:{type:String,required:true},boundary:Schema.Types.Mixed,startedAt:Number,status:String,receivedAt:Number},{timestamps:true});
schema.index({createdAt:1},{expireAfterSeconds:3600});
export const BoundaryTestRun=mongoose.model('BoundaryTestRun',schema);
const zone={lat:10,lon:76,radiusM:100};
export const testStep=(state:any,now:number,inside=false)=>stepBoundary(state,zone,{lat:inside?10:10.01,lon:76,accuracyM:5,recordedAt:now},now);
function allowed(user:any){if(process.env.LOCATION_TEST_MODE!=='true')throw new LinkError(404,'Not found');if(user.role!=='caregiver')throw new LinkError(403,'Only caregivers');}
const view=(r:any)=>({runId:String(r._id),status:r.status,startedAt:r.startedAt,confirmAfter:r.startedAt+cfg.exitConfirmSpanMs,receivedAt:r.receivedAt??null});
async function own(user:any,id:string){allowed(user);if(!/^[a-f0-9]{24}$/i.test(id))throw new LinkError(400,'Invalid test');const r:any=await BoundaryTestRun.findOne({_id:id,userId:user._id});if(!r||Date.now()-r.startedAt>300000)throw new LinkError(404,'Test expired');return r;}
export async function startBoundaryTest(user:any,token:unknown){allowed(user);if(typeof token!=='string'||!await DeviceToken.findOne({userId:user._id,token}))throw new LinkError(403,'This device must register first');const now=Date.now();if(await BoundaryTestRun.exists({userId:user._id,startedAt:{$gt:now-60000}}))throw new LinkError(429,'Wait before starting another test');const inside=testStep(initialBoundaryState(),now,true);const first=testStep(inside.state,now);const r=await BoundaryTestRun.create({userId:user._id,token,startedAt:now,boundary:first.state,status:'waiting'});return view(r);}
export async function confirmBoundaryTest(user:any,id:string){const r=await own(user,id);if(r.status!=='waiting')return view(r);const next=testStep(r.boundary,Date.now());if(!next.alert)throw new LinkError(409,'Wait the full confirmation time');const claimed=await BoundaryTestRun.findOneAndUpdate({_id:r._id,status:'waiting'},{$set:{status:'dispatching',boundary:next.state}},{new:true});if(!claimed)return view(await own(user,id));try{await sendBoundaryTest(String(user._id),r.token,String(r._id));await BoundaryTestRun.updateOne({_id:r._id,status:'dispatching'},{$set:{status:'provider_accepted'}});}catch{await BoundaryTestRun.updateOne({_id:r._id},{$set:{status:'send_failed'}});}return view(await own(user,id));}
export async function readBoundaryTest(user:any,id:string,received=false){const r=await own(user,id);if(received&&['dispatching','provider_accepted','received'].includes(r.status)){await BoundaryTestRun.updateOne({_id:r._id},{$set:{status:'received',receivedAt:Date.now()}});return view(await own(user,id));}return view(r);}
