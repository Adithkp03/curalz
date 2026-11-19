import {it,expect,vi,beforeEach} from 'vitest';
const m=vi.hoisted(()=>({findOne:vi.fn(),send:vi.fn(async()=> 'provider-id')}));
vi.mock('../src/models/LocationModels',()=>({DeviceToken:{findOne:m.findOne}}));
vi.mock('firebase-admin/app',()=>({initializeApp:()=>({}),getApps:()=>[{}],getApp:()=>({}),cert:(x:any)=>x}));
vi.mock('firebase-admin/messaging',()=>({getMessaging:()=>({send:m.send})}));
import {sendBoundaryTest} from '../src/location/fcmSender';
beforeEach(()=>{vi.clearAllMocks();process.env.LOCATION_TEST_MODE='true';process.env.FIREBASE_SERVICE_ACCOUNT_JSON='{}';m.findOne.mockResolvedValue({});});
it('sends only supplied owned device and generic synthetic identifiers,never patient location',async()=>{await sendBoundaryTest('cg','device','run');expect(m.findOne).toHaveBeenCalledWith({userId:'cg',token:'device'});expect(m.send).toHaveBeenCalledWith({token:'device',data:{kind:'boundary_test',runId:'run',recipientId:'cg'},android:{priority:'high',ttl:60000}});});
it('disabled mode or device reassignment prevents dispatch',async()=>{process.env.LOCATION_TEST_MODE='false';await expect(sendBoundaryTest('cg','device','run')).rejects.toThrow();process.env.LOCATION_TEST_MODE='true';m.findOne.mockResolvedValue(null);await expect(sendBoundaryTest('cg','device','run')).rejects.toThrow();expect(m.send).not.toHaveBeenCalled();});
