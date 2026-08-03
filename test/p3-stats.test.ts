import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { withStore } from "../core/store.ts";

let n=0;const paths:string[]=[];
function fresh<T>(fn:(path:string)=>T):T{const path=`${tmpdir().replace(/\\/g,"/")}/presence-p3-${process.pid}-${n++}.db`;paths.push(path);return fn(path);}
afterEach(()=>{for(const path of paths.splice(0))for(const suffix of ["","-wal","-shm"])try{unlinkSync(path+suffix);}catch{}});

describe("P3 raw feature evidence",()=>{
  test("availability, exposure, and use remain independent",()=>fresh(path=>withStore(path,store=>{
    store.setCodeVersion("s1","build-a",["obligations"],1);let f=store.stats(0).features.find(x=>x.feature==="obligations")!;
    expect(f.availability).toMatchObject({observations:1,sessions:1,opportunities:1});expect(f.exposure.observations).toBe(0);expect(f.use.observations).toBe(0);
    store.recordFeatureEvent({sessionId:"s1",feature:"obligations",stage:"use",surface:"cli",opportunityId:"s1",sourceKey:"command-1",nowMs:2});f=store.stats(0).features.find(x=>x.feature==="obligations")!;
    expect(f.availability.observations).toBe(1);expect(f.exposure.observations).toBe(0);expect(f.use.observations).toBe(1);
  })));
  test("twenty repeated session-start observations are one session opportunity",()=>fresh(path=>withStore(path,store=>{
    for(let i=0;i<20;i++)store.setCodeVersion("same-session","same-build",["obligations"],i);const m=store.stats(0).features.find(x=>x.feature==="obligations")!.availability;
    expect(m).toMatchObject({observations:20,sessions:1,opportunities:1});
    store.setCodeVersion("same-session","next-build",["obligations"],21);const next=store.stats(0).features.find(x=>x.feature==="obligations")!.availability;
    expect(next).toMatchObject({observations:21,sessions:1,opportunities:1});
  })));
  test("availability records only capabilities claimed by that build",()=>fresh(path=>{withStore(path,store=>{store.setCodeVersion("s","v",["obligations","not-a-feature"],7,2);expect(store.stats(0).features.find(x=>x.id==="obligations")!.availability.observations).toBe(1);expect(store.stats(0).features.find(x=>x.id==="clearances")!.availability.observations).toBe(0);});const db=new Database(path,{readonly:true});expect((db.query(`SELECT code_version,feature_set_version FROM feature_events`).get() as any)).toEqual({code_version:"v",feature_set_version:2});db.close();}));
  test("actionable delivery, passive context, and help are separate surfaces",()=>fresh(path=>withStore(path,store=>{
    store.recordInjectionResult("s1",{shown:[{key:"obligation:a",dedupeKey:"obligation:a",stateVersion:"v1",form:"full",priority:100,chars:10,actionable:true},{key:"obligation:b",dedupeKey:"obligation:b",stateVersion:"v1",form:"compact",priority:60,chars:8,actionable:false}],omitted:[],nowMs:1});
    store.recordFeatureEvent({sessionId:"s1",feature:"obligations",stage:"exposure",surface:"help",opportunityId:"s1",sourceKey:"help",nowMs:2});
    const exposure=store.stats(0).features.find(x=>x.feature==="obligations")!.exposure;
    expect(exposure).toMatchObject({observations:3,sessions:1,opportunities:1});expect(exposure.surfaces).toEqual([{surface:"actionable",observations:1,sessions:1},{surface:"context",observations:1,sessions:1},{surface:"help",observations:1,sessions:1}]);
  })));
  test("two sessions provide two denominators regardless of event volume",()=>fresh(path=>withStore(path,store=>{
    for(const sid of ["a","b"]){store.recordFeatureEvent({sessionId:sid,feature:"claims",stage:"exposure",surface:"help",opportunityId:sid,sourceKey:"help",nowMs:0});for(let i=0;i<5;i++)store.recordFeatureEvent({sessionId:sid,feature:"claims",stage:"use",surface:"api",opportunityId:sid,sourceKey:`use-${i}`,nowMs:i});}
    expect(store.stats(0).features.find(x=>x.feature==="claims")!.use).toMatchObject({observations:10,sessions:2,opportunities:2});
  })));
  test("exposed non-users stay in the use denominator",()=>fresh(path=>withStore(path,store=>{for(const sid of ["a","b","c"])store.recordFeatureEvent({sessionId:sid,feature:"obligations",stage:"exposure",surface:"help",opportunityId:sid,nowMs:1});store.recordFeatureEvent({sessionId:"a",feature:"obligations",stage:"use",surface:"cli",opportunityId:"a",nowMs:2});expect(store.stats(0).features.find(x=>x.id==="obligations")!.use).toMatchObject({observations:1,sessions:1,opportunities:3});})));
  test("structured API use is recorded in the same transaction and retry dedupes",()=>fresh(path=>withStore(path,store=>{
    const input={senderSessionId:"ada",senderName:"Ada",recipientSessionId:"bob",recipientName:"Bob",acts:[{key:"q",type:"question" as const,text:"Q"},{key:"g",type:"grant" as const,text:"G",scopeText:"scope"},{key:"h",type:"hazard" as const,text:"H",subject:"file"}],idempotencyKey:"batch",nowMs:1};store.obligations.createBatch(input);store.obligations.createBatch(input);
    const byFeature=Object.fromEntries(store.stats(0).features.filter(x=>["obligations","clearances","hazards"].includes(x.feature)).map(x=>[x.feature,x.use.observations]));expect(byFeature).toEqual({obligations:1,clearances:1,hazards:1});
  })));
  test("structured callers preserve whether use came from CLI or API",()=>fresh(path=>withStore(path,store=>{const base={senderSessionId:"ada",senderName:"Ada",recipientSessionId:"bob",recipientName:"Bob",acts:[{key:"q",type:"question" as const,text:"Q"}],nowMs:1};store.obligations.createBatch({...base,idempotencyKey:"api"});store.obligations.createBatch({...base,idempotencyKey:"cli",surface:"cli"});expect(store.stats(0).features.find(x=>x.id==="obligations")!.use.surfaces).toEqual([{surface:"api",observations:1,sessions:1},{surface:"cli",observations:1,sessions:1}]);})));
  test("stats fields survive serialization with their denominators",()=>fresh(path=>withStore(path,store=>{store.setCodeVersion("s","v",["obligations"],1);const parsed=JSON.parse(JSON.stringify(store.stats(0)));const f=parsed.features.find((x:any)=>x.feature==="obligations");expect(f.availability.opportunities).toBe(1);expect(f).toHaveProperty("exposure.observations");expect(f).toHaveProperty("use.sessions");})));
  test("durable measurement evidence is independent of injection suppression retention",()=>fresh(path=>withStore(path,store=>{store.recordFeatureEvent({sessionId:"s",feature:"obligations",stage:"exposure",surface:"help",opportunityId:"s",nowMs:10});store.recordFeatureEvent({sessionId:"s",feature:"obligations",stage:"exposure",surface:"help",opportunityId:"s",sourceKey:"new",nowMs:100});store.pruneInjectionState(100,50);expect(store.stats(0).features.find(x=>x.feature==="obligations")!.exposure.observations).toBe(2);})));
  test("injection-derived observations link to the originating delivery",()=>fresh(path=>{withStore(path,store=>store.recordInjectionResult("s",{shown:[{key:"obligation:o",dedupeKey:"obligation:o",stateVersion:"v",form:"full",priority:100,chars:4,actionable:true}],omitted:[],nowMs:1}));const db=new Database(path,{readonly:true});const row=db.query(`SELECT f.delivery_id feature_delivery,l.delivery_id ledger_delivery FROM feature_events f JOIN injection_ledger l ON l.session_id=f.session_id AND l.delivery_id=f.delivery_id WHERE f.stage='exposure'`).get() as {feature_delivery:number;ledger_delivery:number};expect(row.feature_delivery).toBeGreaterThan(0);expect(row.feature_delivery).toBe(row.ledger_delivery);db.close();}));
  test("invalid identities, stage/surface pairs, and dangling deliveries fail before a row is written",()=>fresh(path=>withStore(path,store=>{expect(()=>store.recordFeatureEvent({sessionId:"",feature:"obligations",stage:"use",surface:"api",opportunityId:"s",nowMs:1})).toThrow();expect(()=>store.recordFeatureEvent({sessionId:"s",feature:"made-up" as any,stage:"use",surface:"api",opportunityId:"s",nowMs:1})).toThrow();expect(()=>store.recordFeatureEvent({sessionId:"s",feature:"obligations",stage:"use",surface:"help" as any,opportunityId:"s",nowMs:1})).toThrow();expect(()=>store.recordFeatureEvent({sessionId:"s",feature:"obligations",stage:"exposure",surface:"actionable",opportunityId:"s",deliveryId:999,nowMs:1})).toThrow();expect(store.stats(0).features.find(x=>x.id==="obligations")!.use.observations).toBe(0);})));
});
