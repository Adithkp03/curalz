import { it, expect, vi } from 'vitest';
const mocks=vi.hoisted(()=>({devices:[] as any[],sendEach:vi.fn(),remove:vi.fn()}));
vi.mock('../src/models/LocationModels',()=>({DeviceToken:{find:async()=>mocks.devices,deleteMany:mocks.remove}}));
vi.mock('firebase-admin/app',()=>({initializeApp:()=>({}),getApps:()=>[{}],getApp:()=>({}),cert:(x:any)=>x}));
vi.mock('firebase-admin/messaging',()=>({getMessaging:()=>({sendEach:mocks.sendEach})}));
import { makeFcmSender } from '../src/location/fcmSender';
it('old devices retain notification, capable devices receive boundary data for local full-screen handling',async()=>{
 process.env.FIREBASE_SERVICE_ACCOUNT_JSON='{}';
 mocks.devices=[{token:'legacy'},{token:'new',boundaryAlertV1:true}];mocks.sendEach.mockResolvedValue({successCount:2,responses:[{success:true},{success:true}]});
 await makeFcmSender()!({userId:'owner',kind:'patient_left_zone',title:'Boundary',body:'Check',data:{eventId:'event',patientId:'patient',lat:'not-forwarded'}});
 const messages=mocks.sendEach.mock.calls[0][0];
 expect(messages[0].notification).toEqual({title:'Boundary',body:'Check'});expect(messages[1].notification).toBeUndefined();
 expect(messages[1].data).toEqual({kind:'patient_left_zone',patientId:'patient',eventId:'event',recipientId:'owner'});
 expect(messages[1].android.ttl).toBe(300000);
});
