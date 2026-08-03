import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { withStore } from "../core/store.ts";
import { sessionEnvelope } from "../core/sessionBlock.ts";
import { pack } from "../core/injection.ts";
import {
  ObligationError, foldClearance, foldObligation, obligationPriority, stateVersion, validateCondition,
  type ActorRef,type CreateObligationInput,type ObligationDefinition,type ObligationEvent,type ObligationEventRecord,
} from "../core/obligations.ts";

const ada:ActorRef={kind:"agent",agentId:"ada"}; const bob:ActorRef={kind:"agent",agentId:"bob"};
const op:ActorRef={kind:"operator"}; const sys:ActorRef={kind:"system",component:"conditions"};
const def=(over:Partial<ObligationDefinition>={}):ObligationDefinition=>({id:"o1",sourceActId:"a1",sourceMessageId:1,createdBy:ada,kind:"promise",mode:"perform",validResolutionKeys:[],text:"I will do it",priority:"important",...over});
const rec=(version:number,payload:ObligationEvent,actor:ActorRef=ada):ObligationEventRecord=>({id:`e${version}`,obligationId:"o1",actor,occurredAt:100+version,expectedVersion:version,idempotencyKey:`k${version}`,payload});
const created=(authority:"binding"|"proposed"="binding",activation:"active"|"waiting"="active",responsible:any={kind:"assigned",actor:ada})=>rec(0,{type:"created",authority,activation,responsible});
const fold=(events:ObligationEventRecord[],d=def())=>foldObligation(d,events);
const throws=(fn:()=>unknown,code:string)=>{try{fn();throw new Error("did not throw");}catch(e){expect(e).toBeInstanceOf(ObligationError);expect((e as ObligationError).code).toBe(code);}};

describe("obligation fold transition table",()=>{
  test.each([
    ["accepted",created("proposed"),{type:"accepted"},"binding","active"],
    ["declined",created("proposed"),{type:"declined"},"declined","active"],
    ["countered",created("proposed"),{type:"countered",replacementId:"o2"},"countered","active"],
    ["withdrawn",created("proposed"),{type:"withdrawn"},"withdrawn","active"],
    ["cancelled proposed",created("proposed"),{type:"cancelled",reason:"moot"},"cancelled","active"],
    ["cancelled binding",created(),{type:"cancelled",reason:"moot"},"cancelled","active"],
    ["activated",created("binding","waiting"),{type:"activated",trigger:{kind:"work_completed",workId:"w1"}},"binding","active"],
    ["fulfilled",created(),{type:"fulfilled"},"binding","fulfilled"],
    ["released",created("binding","waiting"),{type:"released",why:"moot"},"binding","released"],
    ["violated",created(),{type:"violated"},"binding","violated"],
    ["expired active",created(),{type:"expired",episodeId:"ep"},"binding","expired"],
    ["expired waiting",created("binding","waiting"),{type:"expired",episodeId:"ep"},"binding","expired"],
  ] as const)("folds %s",(_name,start,event,authority,activation)=>{const s=fold([start,rec(1,event as ObligationEvent)]);expect(s.authority).toBe(authority);expect(s.activation).toBe(activation);expect(s.version).toBe(2);});

  test("ownership moves never alter authority or activation",()=>{
    const unowned=fold([created(),rec(1,{type:"relinquished",from:ada})]);expect(unowned.currentResponsible.kind).toBe("unassigned");expect(unowned.activation).toBe("active");
    const assigned=fold([created(),rec(1,{type:"relinquished",from:ada}),rec(2,{type:"assigned",to:bob},op)]);expect(assigned.currentResponsible).toEqual({kind:"assigned",actor:bob});
    const moved=fold([created(),rec(1,{type:"reassigned",from:ada,to:bob})]);expect(moved.currentResponsible).toEqual({kind:"assigned",actor:bob});
    const returned=fold([created(),rec(1,{type:"returned",from:ada,to:bob})]);expect(returned.currentResponsible).toEqual({kind:"assigned",actor:bob});
  });
  test("active refrain success is fulfilled, never released",()=>{throws(()=>fold([created(),rec(1,{type:"released",why:"boundary"})]),"transition");expect(fold([created(),rec(1,{type:"fulfilled"})]).activation).toBe("fulfilled");});
  test("resolution keys are declared, optional only for unbranched resolution",()=>{const d=def({validResolutionKeys:["yes","no"]});expect(fold([created(),rec(1,{type:"fulfilled",resolutionKey:"yes"})],d).activation).toBe("fulfilled");throws(()=>fold([created(),rec(1,{type:"fulfilled",resolutionKey:"typo"})],d),"resolution");});
  test.each([
    [created(),{type:"accepted"}],[created("proposed"),{type:"fulfilled"}],[created(),{type:"activated",trigger:{kind:"work_completed",workId:"w"}}],
    [created("binding","waiting"),{type:"fulfilled"}],[created(),{type:"released",why:"x"}],[created(),{type:"assigned",to:bob}],
    [created("proposed"),{type:"relinquished",from:ada}],
  ] as const)("rejects illegal state pair %#",(start,event)=>throws(()=>fold([start,rec(1,event as ObligationEvent)]),"transition"));
  test("created is first, unique, version-contiguous, and obligation-local",()=>{
    throws(()=>fold([rec(0,{type:"fulfilled"})]),"corrupt");throws(()=>fold([created(),rec(1,{type:"created",authority:"binding",activation:"active",responsible:{kind:"assigned",actor:ada}})]),"transition");
    throws(()=>fold([created(),{...rec(2,{type:"fulfilled"}),expectedVersion:9}]),"corrupt");throws(()=>fold([created(),{...rec(1,{type:"fulfilled"}),obligationId:"other"}]),"corrupt");
  });
  test("state version is deterministic, timestamp-free, and changes with event version",()=>{const a=fold([created()]);const b=fold([{...created(),occurredAt:9999,id:"different"}]);expect(stateVersion(a)).toBe(stateVersion(b));expect(stateVersion(fold([created(),rec(1,{type:"reassigned",from:ada,to:ada})]))).not.toBe(stateVersion(a));});
});

describe("typed condition and priority invariants",()=>{
  test.each([
    {text:"land",handling:"automatic",trigger:{kind:"commit_reachable",commitSha:"abc",branch:"master"}},
    {text:"done",handling:"automatic",trigger:{kind:"work_completed",workId:"w1"}},
    {text:"step",handling:"automatic",trigger:{kind:"work_step_completed",workId:"w1",step:2}},
    {text:"answer",handling:"automatic",trigger:{kind:"obligation_resolved",obligationId:"o1",resolutionKey:"yes"}},
    {text:"related",handling:"resurface_on_related_event",event:{kind:"work_updated",workId:"w1"}},
    {text:"human",handling:"manual"},
  ] as any[])("accepts condition %#",c=>expect(()=>validateCondition(c)).not.toThrow());
  test.each([
    {text:"",handling:"manual"},{text:"x",handling:"automatic",trigger:{kind:"commit_reachable",commitSha:"",branch:"main"}},
    {text:"x",handling:"automatic",trigger:{kind:"work_step_completed",workId:"w",step:0}},{text:"x",handling:"resurface_on_related_event",event:{kind:"obligation_updated",obligationId:""}},
  ] as any[])("rejects malformed condition %#",c=>throws(()=>validateCondition(c),"invalid"));
  test("priority preserves the P0 bands",()=>expect([obligationPriority("urgent"),obligationPriority("important"),obligationPriority("normal")]).toEqual([110,105,100]));
});

let seq=0;const paths:string[]=[];
const fresh=<T>(fn:(path:string)=>T):T=>{const path=`${tmpdir().replace(/\\/g,"/")}/presence-obligation-${process.pid}-${seq++}.db`;paths.push(path);return fn(path);};
afterEach(()=>{for(const p of paths.splice(0))for(const suffix of ["","-wal","-shm"])try{unlinkSync(p+suffix);}catch{}});
const input=(over:Partial<CreateObligationInput>={}):CreateObligationInput=>({id:"o1",sourceActId:"a1",sourceMessageId:1,createdBy:ada,kind:"promise",mode:"perform",validResolutionKeys:[],text:"I will do it",priority:"important",initial:{authority:"binding",activation:"active",responsible:{kind:"assigned",actor:ada}},actor:ada,idempotencyKey:"create",nowMs:1,...over});
const event=(version:number,payload:ObligationEvent,actor:ActorRef=ada,key=`k${version}`):ObligationEventRecord=>({id:`e-${key}`,obligationId:"o1",actor,occurredAt:10+version,expectedVersion:version,idempotencyKey:key,payload});

describe("obligation store uses real SQLite transactions",()=>{
  test("fresh schema creates, reads, and folds immutable definition plus event",()=>fresh(path=>withStore(path,s=>{const d=s.obligations.create(input());expect(d.id).toBe("o1");expect(s.obligations.events("o1")).toHaveLength(1);expect(s.obligations.snapshot("o1")?.version).toBe(1);}))); 
  test("migration is additive and opening twice is idempotent",()=>fresh(path=>{withStore(path,()=>{});withStore(path,s=>expect(s.obligations.snapshot("missing")).toBeNull());}));
  test("append validates expected version and exactly one stale writer loses",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());expect(s.obligations.append(event(1,{type:"fulfilled"})).activation).toBe("fulfilled");throws(()=>s.obligations.append(event(1,{type:"cancelled",reason:"late"},ada,"late")),"stale_version");expect(s.obligations.events("o1")).toHaveLength(2);}))); 
  test("two independent SQLite connections cannot both win the same version",()=>fresh(path=>withStore(path,first=>{first.obligations.create(input());withStore(path,second=>{first.obligations.append(event(1,{type:"fulfilled"},ada,"winner"));throws(()=>second.obligations.append(event(1,{type:"violated"},ada,"loser")),"stale_version");});expect(first.obligations.events("o1")).toHaveLength(2);}))); 
  test("idempotent retry returns the existing fold without a duplicate row",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());const e=event(1,{type:"fulfilled"});const a=s.obligations.append(e);const b=s.obligations.append({...e,id:"retry",occurredAt:999});expect(b).toEqual(a);expect(s.obligations.events("o1")).toHaveLength(2);}))); 
  test("idempotency key cannot disguise a different payload or actor",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());s.obligations.append(event(1,{type:"fulfilled"}));throws(()=>s.obligations.append(event(1,{type:"violated"},ada,"k1")),"idempotency_conflict");throws(()=>s.obligations.append(event(1,{type:"fulfilled"},bob,"k1")),"idempotency_conflict");}))); 
  test("failed transition and failed authorization append nothing",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());throws(()=>s.obligations.append(event(1,{type:"accepted"})),"transition");throws(()=>s.obligations.append(event(1,{type:"fulfilled"},bob)),"forbidden");expect(s.obligations.events("o1")).toHaveLength(1);}))); 
  test.each([
    ["accept owner",input({kind:"request",mode:undefined,createdBy:ada,initial:{authority:"proposed",activation:"active",responsible:{kind:"assigned",actor:bob}}}),event(1,{type:"accepted"},bob)],
    ["withdraw creator",input({kind:"request",mode:undefined,initial:{authority:"proposed",activation:"active",responsible:{kind:"assigned",actor:bob}}}),event(1,{type:"withdrawn"},ada)],
    ["assign operator",input({kind:"unassigned_work",mode:undefined,initial:{authority:"binding",activation:"active",responsible:{kind:"unassigned"}}}),event(1,{type:"assigned",to:bob},op)],
    ["violate system",input(),event(1,{type:"violated"},sys)],
  ] as const)("authorizes %s",(_n,create,e)=>fresh(path=>withStore(path,s=>{s.obligations.create(create);expect(()=>s.obligations.append(e)).not.toThrow();})));
  test("legacy uncertain cannot author or perform new writes",()=>fresh(path=>withStore(path,s=>{throws(()=>s.obligations.create(input({createdBy:{kind:"legacy_uncertain",label:"maybe"}})),"attribution");s.obligations.create(input());throws(()=>s.obligations.append(event(1,{type:"fulfilled"},{kind:"legacy_uncertain",label:"maybe"})),"forbidden");}))); 
  test("refrain requires a release boundary and promise owner is author",()=>fresh(path=>withStore(path,s=>{throws(()=>s.obligations.create(input({mode:"refrain"})),"invalid");throws(()=>s.obligations.create(input({initial:{authority:"binding",activation:"active",responsible:{kind:"assigned",actor:bob}}})),"invalid");}))); 
  test("duplicate ids and source acts are constrained without partial event rows",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());throws(()=>s.obligations.create(input({id:"o2"})),"conflict");expect(s.obligations.events("o2")).toHaveLength(0);}))); 
});

describe("P0 delivery integration",()=>{
  test("active and proposed work become actionable candidates above roster",()=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input({priority:"urgent"}));const c=s.obligations.candidates("ada");expect(c).toHaveLength(1);expect(c[0]).toMatchObject({key:"obligation:o1",dedupeKey:"obligation:o1",priority:110,actionable:true,origin:"peer",requiresPeerFraming:true});
  })));
  test("waiting work is compact context, below roster, and not actionable",()=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input({initial:{authority:"binding",activation:"waiting",responsible:{kind:"assigned",actor:ada}},condition:{text:"when done",handling:"manual"}}));expect(s.obligations.candidates("ada")[0]).toMatchObject({priority:60,actionable:false});
  })));
  test("other owners and terminal obligations produce no candidate",()=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input());expect(s.obligations.candidates("bob")).toEqual([]);s.obligations.append(event(1,{type:"fulfilled"}));expect(s.obligations.candidates("ada")).toEqual([]);
  })));
  test("unassigned responsibility gap is visible only to operator view",()=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input({kind:"unassigned_work",mode:undefined,initial:{authority:"binding",activation:"active",responsible:{kind:"unassigned"}}}));expect(s.obligations.candidates("ada")).toEqual([]);expect(s.obligations.candidates("",true)[0]?.actionable).toBe(true);
  })));
  test("real session envelope carries the exact P2 candidate into P0",()=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input());const env=sessionEnvelope(s,{me:"Ada",projectName:"Traffic",sessionId:"ada",tree:"I:/Traffic",now:100,staleness:[],lineageFrom:""});expect(env.candidates.find(x=>x.key==="obligation:o1")).toEqual(s.obligations.candidates("ada")[0]);
  })));
  test("actionable no-room omission reaches P0 inbox with its exact state version",()=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input());const c=s.obligations.candidates("ada")[0]!;s.recordInjectionResult("ada",{shown:[],omitted:[{key:c.key,dedupeKey:c.dedupeKey,stateVersion:c.stateVersion,text:c.text,reason:"no room",priority:c.priority,actionable:c.actionable}],nowMs:10});const inbox=s.injectionOmissions("ada");expect(inbox).toHaveLength(1);expect(inbox[0]).toMatchObject({key:"obligation:o1",stateVersion:c.stateVersion,text:c.text});
  })));
  test("waiting no-room omission is ledgered but never put in actionable inbox",()=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input({initial:{authority:"binding",activation:"waiting",responsible:{kind:"assigned",actor:ada}},condition:{text:"later",handling:"manual"}}));const c=s.obligations.candidates("ada")[0]!;s.recordInjectionResult("ada",{shown:[],omitted:[{key:c.key,dedupeKey:c.dedupeKey,stateVersion:c.stateVersion,text:c.text,reason:"no room",priority:c.priority,actionable:false}],nowMs:10});expect(s.injectionOmissions("ada")).toEqual([]);expect(s.injectionHistory("ada").some(x=>x.key==="obligation:o1"&&x.outcome==="omitted")).toBe(true);
  })));
});

describe("obligation dependencies are atomic",()=>{
  const second=(over:Partial<CreateObligationInput>={}):CreateObligationInput=>input({id:"o2",sourceActId:"a2",text:"dependent",initial:{authority:"binding",activation:"waiting",responsible:{kind:"assigned",actor:ada}},condition:{text:"after answer",handling:"automatic",trigger:{kind:"obligation_resolved",obligationId:"o1"}},idempotencyKey:"create2",...over});
  test.each(["activate","release"] as const)("fulfilled source derives %s in the same append",effect=>fresh(path=>withStore(path,s=>{
    s.obligations.create(input({kind:"question",mode:undefined,validResolutionKeys:["yes"]}));s.obligations.create(second());s.obligations.addDependency({sourceObligationId:"o1",resolutionKey:"yes",targetObligationId:"o2",effect});s.obligations.append(event(1,{type:"fulfilled",resolutionKey:"yes"}));expect(s.obligations.snapshot("o2")?.activation).toBe(effect==="activate"?"active":"released");expect(s.obligations.events("o2")).toHaveLength(2);
  })));
  test("a different resolution branch has no effect",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input({kind:"question",mode:undefined,validResolutionKeys:["yes","no"]}));s.obligations.create(second());s.obligations.addDependency({sourceObligationId:"o1",resolutionKey:"yes",targetObligationId:"o2",effect:"activate"});s.obligations.append(event(1,{type:"fulfilled",resolutionKey:"no"}));expect(s.obligations.snapshot("o2")?.activation).toBe("waiting");})));
  test("invalid derived transition rolls the source event back too",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input({kind:"question",mode:undefined}));s.obligations.create(second({initial:{authority:"binding",activation:"active",responsible:{kind:"assigned",actor:ada}},condition:undefined}));s.obligations.addDependency({sourceObligationId:"o1",targetObligationId:"o2",effect:"activate"});throws(()=>s.obligations.append(event(1,{type:"fulfilled"})),"transition");expect(s.obligations.events("o1")).toHaveLength(1);expect(s.obligations.events("o2")).toHaveLength(1);}))); 
  test("rejects self edges, cycles, unknown ids and undeclared branches",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());s.obligations.create(second());throws(()=>s.obligations.addDependency({sourceObligationId:"o1",targetObligationId:"o1",effect:"activate"}),"dependency_cycle");throws(()=>s.obligations.addDependency({sourceObligationId:"missing",targetObligationId:"o2",effect:"activate"}),"not_found");throws(()=>s.obligations.addDependency({sourceObligationId:"o1",resolutionKey:"bad",targetObligationId:"o2",effect:"activate"}),"resolution");s.obligations.addDependency({sourceObligationId:"o1",targetObligationId:"o2",effect:"activate"});throws(()=>s.obligations.addDependency({sourceObligationId:"o2",targetObligationId:"o1",effect:"activate"}),"dependency_cycle");})));
  test("duplicate edge is a constrained conflict",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());s.obligations.create(second());const d={sourceObligationId:"o1",targetObligationId:"o2",effect:"activate"} as const;s.obligations.addDependency(d);throws(()=>s.obligations.addDependency(d),"conflict");})));
  test("one branch cannot both activate and release one target",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());s.obligations.create(second());s.obligations.addDependency({sourceObligationId:"o1",targetObligationId:"o2",effect:"activate"});throws(()=>s.obligations.addDependency({sourceObligationId:"o1",targetObligationId:"o2",effect:"release"}),"dependency_conflict");})));
});

describe("clearance lifecycle is separate and append-only",()=>{
  const cd={id:"c1",sourceActId:"grant-a",sourceMessageId:1,scopeText:"the sim kernel",grantedBy:ada,grantedTo:bob};
  const ce=(version:number,payload:any,actor:ActorRef=ada,key=`c${version}`)=>({id:`ce${version}`,clearanceId:"c1",actor,occurredAt:version,expectedVersion:version,idempotencyKey:key,payload});
  test("pure fold grants then revokes or expires",()=>{expect(foldClearance(cd,[ce(0,{type:"granted"})]).state).toBe("active");expect(foldClearance(cd,[ce(0,{type:"granted"}),ce(1,{type:"revoked"})]).state).toBe("revoked");expect(foldClearance(cd,[ce(0,{type:"granted"}),ce(1,{type:"expired",reason:"episode ended"},sys)]).state).toBe("expired");});
  test("terminal clearance cannot be granted, revoked, or expired again",()=>{throws(()=>foldClearance(cd,[ce(0,{type:"granted"}),ce(1,{type:"revoked"}),ce(2,{type:"expired",reason:"x"},sys)]),"transition");throws(()=>foldClearance(cd,[ce(0,{type:"granted"}),ce(1,{type:"granted"})]),"transition");});
  test("creation is atomic and requires authenticated trustworthy grantor",()=>fresh(path=>withStore(path,s=>{expect(s.obligations.createClearance({...cd,actor:ada,idempotencyKey:"grant",nowMs:1}).id).toBe("c1");expect(s.obligations.clearanceSnapshot("c1")?.state).toBe("active");throws(()=>s.obligations.createClearance({...cd,id:"c2",sourceActId:"a2",actor:bob,idempotencyKey:"x",nowMs:1}),"attribution");})));
  test("grantor and operator revoke; arbitrary peer cannot",()=>fresh(path=>withStore(path,s=>{s.obligations.createClearance({...cd,actor:ada,idempotencyKey:"grant",nowMs:1});throws(()=>s.obligations.appendClearance(ce(1,{type:"revoked"},bob)),"forbidden");expect(s.obligations.appendClearance(ce(1,{type:"revoked",reason:"done"},op)).state).toBe("revoked");})));
  test("only system or operator expires",()=>fresh(path=>withStore(path,s=>{s.obligations.createClearance({...cd,actor:ada,idempotencyKey:"grant",nowMs:1});throws(()=>s.obligations.appendClearance(ce(1,{type:"expired",reason:"done"},bob)),"forbidden");expect(s.obligations.appendClearance(ce(1,{type:"expired",reason:"done"},sys)).state).toBe("expired");})));
  test("clearance appends enforce version and idempotent retry",()=>fresh(path=>withStore(path,s=>{s.obligations.createClearance({...cd,actor:ada,idempotencyKey:"grant",nowMs:1});const e=ce(1,{type:"revoked"},ada,"revoke");expect(s.obligations.appendClearance(e)).toEqual(s.obligations.appendClearance({...e,id:"retry"}));expect(s.obligations.clearanceEvents("c1")).toHaveLength(2);throws(()=>s.obligations.appendClearance(ce(1,{type:"expired",reason:"late"},sys,"late")),"stale_version");})));
  test("release boundary is typed but scope remains opaque text",()=>fresh(path=>withStore(path,s=>{const d=s.obligations.createClearance({...cd,releaseBoundary:{text:"when work ends",handling:"automatic",trigger:{kind:"work_completed",workId:"w1"}},actor:ada,idempotencyKey:"grant",nowMs:1});expect(d.scopeText).toBe("the sim kernel");expect(d.releaseBoundary?.handling).toBe("automatic");})));
});

describe("atomic structured act batches",()=>{
  const batch=(acts:any[],over:any={})=>({senderSessionId:"ada",senderName:"Ada",recipientSessionId:"bob",recipientName:"Bob",acts,idempotencyKey:"batch-1",nowMs:100,...over});
  test("one compound message creates several independent acts and obligations",()=>fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"q",type:"question",text:"Which folder?",resolutionKeys:["unit","browser"]},{key:"p",type:"promise",text:"I will move it",mode:"perform",condition:{text:"after answer",handling:"automatic",trigger:{kind:"obligation_resolved",obligationId:"pending",resolutionKey:"unit"}}}],{dependencies:[{sourceKey:"q",resolutionKey:"unit",targetKey:"p",effect:"activate"}]}));expect(Object.keys(r.actIds)).toEqual(["q","p"]);expect(Object.keys(r.obligationIds)).toEqual(["q","p"]);expect(s.obligations.snapshot(r.obligationIds.q!)?.activation).toBe("active");expect(s.obligations.snapshot(r.obligationIds.p!)?.activation).toBe("waiting");expect(s.obligations.dependencies(r.obligationIds.q!)).toHaveLength(1);}))); 
  test("batch idempotent retry returns identical ids and creates one message",()=>fresh(path=>withStore(path,s=>{const b=batch([{key:"q",type:"question",text:"Ready?"}]);const a=s.obligations.createBatch(b),c=s.obligations.createBatch(b);expect(c).toEqual(a);expect(s.obligations.all()).toHaveLength(1);}))); 
  test("same batch key with changed input is rejected",()=>fresh(path=>withStore(path,s=>{s.obligations.createBatch(batch([{key:"q",type:"question",text:"Ready?"}]));throws(()=>s.obligations.createBatch(batch([{key:"q",type:"question",text:"Different?"}])),"idempotency_conflict");})));
  test("invalid final dependency rolls back message, acts, and obligations",()=>fresh(path=>withStore(path,s=>{throws(()=>s.obligations.createBatch(batch([{key:"a",type:"question",text:"A"},{key:"b",type:"correction",text:"B",correctionType:"self_erratum"}],{dependencies:[{sourceKey:"a",targetKey:"b",effect:"activate"}]})),"invalid");expect(s.obligations.all()).toEqual([]);expect(s.recent(10)).toEqual([]);}))); 
  test("duplicate keys and empty batches fail before writing",()=>fresh(path=>withStore(path,s=>{throws(()=>s.obligations.createBatch(batch([])),"invalid");throws(()=>s.obligations.createBatch(batch([{key:"x",type:"question",text:"A"},{key:"x",type:"question",text:"B"}])),"invalid");expect(s.recent(10)).toEqual([]);}))); 
  test("question is binding, assigned request/handoff proposed, promise binding",()=>fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"q",type:"question",text:"Q"},{key:"r",type:"request",text:"R"},{key:"h",type:"handoff",text:"H",subject:"file"},{key:"p",type:"promise",text:"P",mode:"perform"}]));expect(["q","r","h","p"].map(k=>s.obligations.snapshot(r.obligationIds[k]!)?.authority)).toEqual(["binding","proposed","proposed","binding"]);expect(s.obligations.snapshot(r.obligationIds.p!)?.currentResponsible).toEqual({kind:"assigned",actor:ada});})));
  test("unassigned request starts binding as a responsibility gap",()=>fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"r",type:"request",text:"Someone investigate",unassigned:true}]));expect(s.obligations.snapshot(r.obligationIds.r!)).toMatchObject({authority:"binding",currentResponsible:{kind:"unassigned"}});}))); 
  test("grant creates clearance, correction creates no obligation, hazard stays orthogonal",()=>fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"g",type:"grant",text:"Go ahead",scopeText:"sim kernel"},{key:"c",type:"correction",text:"I was wrong",correctionType:"self_erratum"},{key:"z",type:"hazard",text:"Concurrent edit will collide",subject:"emit.ts"}]));expect(s.obligations.clearanceSnapshot(r.clearanceIds.g!)?.state).toBe("active");expect(r.obligationIds).toEqual({});expect(Object.keys(r.actIds)).toEqual(["g","c","z"]);}))); 
  test("refrain is impossible without a release boundary",()=>fresh(path=>withStore(path,s=>throws(()=>s.obligations.createBatch(batch([{key:"p",type:"promise",text:"I will stay out",mode:"refrain"}])),"invalid"))));
  test("rendered prose is derived from typed acts in source order",()=>fresh(path=>withStore(path,s=>{s.obligations.createBatch(batch([{key:"q",type:"question",text:"Where?"},{key:"p",type:"promise",text:"I will move it",mode:"perform"}]));expect(s.recent(1)[0]?.body).toBe("QUESTION: Where?\nPROMISE: I will move it");})));
  test("deferred schema fields cannot be smuggled into known records",()=>fresh(path=>withStore(path,s=>{for(const field of ["constraints","anchors","confidence","provenance"]){const malicious:any={key:"q",type:"question",text:"Q",[field]:true};throws(()=>s.obligations.createBatch(batch([malicious],{idempotencyKey:`bad-${field}`})),"invalid");}expect(s.obligations.all()).toEqual([]);}))); 
  test("unsupported correction subtypes and dangling correction targets are rejected atomically",()=>fresh(path=>withStore(path,s=>{throws(()=>s.obligations.createBatch(batch([{key:"c",type:"correction",text:"wrong",correctionType:"guess"}] as any,{idempotencyKey:"bad-subtype"})),"invalid");throws(()=>s.obligations.createBatch(batch([{key:"c",type:"correction",text:"wrong",correctionType:"peer_correction",contradictsActId:"missing"}],{idempotencyKey:"bad-target"})),"not_found");expect(s.recent(10)).toEqual([]);}))); 
  test("hazards may reference later acts and reject references outside the atomic batch",()=>fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"warning",type:"hazard",text:"Do not collide",subject:"file",relatedActKeys:["work"]},{key:"work",type:"request",text:"Edit it"}]));expect(s.obligations.hazards(r.messageId)[0]?.relatedActIds).toEqual([r.actIds.work!]);throws(()=>s.obligations.createBatch(batch([{key:"bad",type:"hazard",text:"x",subject:"x",relatedActKeys:["missing"]}],{idempotencyKey:"bad-related"})),"invalid");})));
});

describe("P2 frozen-corpus acceptance scenarios",()=>{
  const batch=(acts:any[],dependencies?:any[])=>({senderSessionId:"ada",senderName:"Ada",recipientSessionId:"bob",recipientName:"Bob",acts,dependencies,idempotencyKey:`corpus-${seq++}`,nowMs:100});
  test("#36 answer branch activates the dependent move promise",()=>fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"q",type:"question",text:"Where?",resolutionKeys:["unit","browser"]},{key:"move",type:"promise",text:"Move tests",mode:"perform",condition:{text:"after answer",handling:"automatic",trigger:{kind:"obligation_resolved",obligationId:"question",resolutionKey:"unit"}}}],[{sourceKey:"q",resolutionKey:"unit",targetKey:"move",effect:"activate"}]));const q=r.obligationIds.q!,move=r.obligationIds.move!;s.obligations.append({id:"answer",obligationId:q,actor:bob,occurredAt:101,expectedVersion:1,idempotencyKey:"answer",payload:{type:"fulfilled",resolutionKey:"unit"}});expect(s.obligations.snapshot(move)?.activation).toBe("active");})));
  test("#97 refrain remains waiting and cannot be falsely fulfilled",()=>fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"stay",type:"promise",text:"Do not touch emit",mode:"refrain",condition:{text:"when peer edits",handling:"resurface_on_related_event",event:{kind:"work_updated",workId:"w"}},releaseBoundary:{text:"when returned",handling:"manual"}}]));const id=r.obligationIds.stay!;expect(s.obligations.snapshot(id)?.activation).toBe("waiting");throws(()=>s.obligations.append({id:"false",obligationId:id,actor:ada,occurredAt:2,expectedVersion:1,idempotencyKey:"false",payload:{type:"fulfilled"}}),"transition");})));
  test("#146 branches cleanly between activation and release",()=>{for(const effect of ["activate","release"] as const)fresh(path=>withStore(path,s=>{const r=s.obligations.createBatch(batch([{key:"q",type:"question",text:"Still needed?",resolutionKeys:[effect]},{key:"edit",type:"promise",text:"Edit",mode:"perform",condition:{text:"after decision",handling:"manual"}}],[{sourceKey:"q",resolutionKey:effect,targetKey:"edit",effect}]));s.obligations.append({id:`resolve-${effect}`,obligationId:r.obligationIds.q!,actor:bob,occurredAt:2,expectedVersion:1,idempotencyKey:`resolve-${effect}`,payload:{type:"fulfilled",resolutionKey:effect}});expect(s.obligations.snapshot(r.obligationIds.edit!)?.activation).toBe(effect==="activate"?"active":"released");}));});
  test("#295 relinquish, assign, and return preserve binding work",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());s.obligations.append(event(1,{type:"relinquished",from:ada}));expect(s.obligations.snapshot("o1")).toMatchObject({authority:"binding",activation:"active",currentResponsible:{kind:"unassigned"}});s.obligations.append(event(2,{type:"assigned",to:bob},op));s.obligations.append(event(3,{type:"returned",from:bob,to:ada},bob));expect(s.obligations.snapshot("o1")?.currentResponsible).toEqual({kind:"assigned",actor:ada});})));
});

describe("P2 exhaustive gate",()=>{
  test("generated legal histories replay deterministically with monotonic versions and one owner",()=>{
    for(let seed=1;seed<=100;seed++){const events=[created()];let owner=ada;for(let i=1;i<=20;i++){const next=seed+i;if(next%3===0){events.push(rec(i,{type:"reassigned",from:owner,to:owner===ada?bob:ada},owner));owner=owner===ada?bob:ada;}else events.push(rec(i,{type:"reassigned",from:owner,to:owner},owner));const a=fold(events),b=fold(events.map(x=>({...x,payload:structuredClone(x.payload)})));expect(a).toEqual(b);expect(a.version).toBe(i+1);expect(a.authority).toBe("binding");expect(a.activation).toBe("active");expect(a.currentResponsible).toEqual({kind:"assigned",actor:owner});}
    }
  });
  test("generated illegal terminal continuations are rejected without store append",()=>fresh(path=>withStore(path,s=>{for(const [index,terminal] of ([{type:"fulfilled"},{type:"violated"},{type:"cancelled",reason:"stop"}] as ObligationEvent[]).entries()){const id=`terminal-${index}`;s.obligations.create(input({id,sourceActId:`ta-${index}`,idempotencyKey:`tc-${index}`}));s.obligations.append({...event(1,terminal),id:`te-${index}`,obligationId:id,idempotencyKey:`term-${index}`});const count=s.obligations.events(id).length;throws(()=>s.obligations.append({...event(2,{type:"reassigned",from:ada,to:bob}),id:`bad-${index}`,obligationId:id,idempotencyKey:`bad-${index}`}),"transition");expect(s.obligations.events(id)).toHaveLength(count);}})));
  test("authorization matrix rejects every relevant wrong principal and unknown system",()=>fresh(path=>withStore(path,s=>{
    const cases:Array<[CreateObligationInput,ObligationEvent,ActorRef,string]>= [
      [input({kind:"request",mode:undefined,initial:{authority:"proposed",activation:"active",responsible:{kind:"assigned",actor:bob}}}),{type:"accepted"},ada,"accept"],
      [input({kind:"request",mode:undefined,initial:{authority:"proposed",activation:"active",responsible:{kind:"assigned",actor:bob}}}),{type:"withdrawn"},bob,"withdraw"],
      [input(),{type:"fulfilled"},bob,"fulfil"],[input(),{type:"relinquished",from:ada},bob,"relinquish"],
      [input({kind:"unassigned_work",mode:undefined,initial:{authority:"binding",activation:"active",responsible:{kind:"unassigned"}}}),{type:"assigned",to:bob},ada,"assign"],
      [input(),{type:"cancelled",reason:"x"},bob,"cancel"],[input(),{type:"activated",trigger:{kind:"work_completed",workId:"w"}},{kind:"system",component:"unknown"},"system"],
    ];
    cases.forEach(([base,payload,actor,label],i)=>{const id=`auth-${i}`;s.obligations.create({...base,id,sourceActId:`auth-act-${i}`,idempotencyKey:`auth-create-${i}`});throws(()=>s.obligations.append({id:`auth-event-${i}`,obligationId:id,actor,occurredAt:2,expectedVersion:1,idempotencyKey:`auth-${label}`,payload}),"forbidden");expect(s.obligations.events(id)).toHaveLength(1);});
  })));
  test("obligation candidates exercise full, compact, suppression, changed version, and no-room delivery",()=>fresh(path=>withStore(path,s=>{s.obligations.create(input());const c=s.obligations.candidates("ada")[0]!;const env={mandatoryHeader:["header"],peerFraming:["trust"],candidates:[c],targetChars:10_000};const full=pack(env);expect(full.selected[0]?.form).toBe("full");s.recordInjectionResult("ada",{shown:full.selected.map(x=>({key:x.candidate.key,dedupeKey:x.candidate.dedupeKey,stateVersion:x.candidate.stateVersion,form:x.form,priority:x.candidate.priority,chars:x.text.length})),omitted:[],nowMs:1});const suppressed=pack(env,s.injectionExposures("ada"));expect(suppressed.omitted.filter(x=>x.reason==="unchanged").map(x=>x.candidate.key)).toEqual([c.key]);s.obligations.append(event(1,{type:"reassigned",from:ada,to:ada}));const changed=s.obligations.candidates("ada")[0]!;expect(pack({...env,candidates:[changed]},s.injectionExposures("ada")).selected).toHaveLength(1);const compact=pack({...env,targetChars:changed.compact!.length+20,candidates:[changed]});expect(compact.selected[0]?.form).toBe("compact");const omitted=pack({...env,targetChars:1,candidates:[changed]});expect(omitted.omitted.some(x=>x.candidate.key===changed.key&&x.reason==="no room")).toBe(true);s.clearInjectionExposures("ada");expect(pack({...env,candidates:[changed]},s.injectionExposures("ada")).selected).toHaveLength(1);}))); 
  test("schema contains the supported slice and no deferred or parallel exposure representation",()=>fresh(path=>{withStore(path,()=>{});const db=new Database(path,{readonly:true});const rows=db.query(`SELECT name,sql FROM sqlite_master WHERE type IN ('table','index')`).all() as Array<{name:string;sql:string|null}>;const names=new Set(rows.map(r=>r.name));for(const name of ["message_acts","semantic_batches","obligations","obligation_events","obligation_dependencies","clearances","clearance_events","hazard_notices","message_deliveries"])expect(names.has(name)).toBe(true);for(const forbidden of ["constraint","anchor","confidence","provenance","inferred_signal","reported_act","feature_exposure"])expect(rows.some(r=>r.name.toLowerCase().includes(forbidden)||r.sql?.toLowerCase().includes(`${forbidden}_json`))).toBe(false);db.close();}));
  test("restart rebuilds folds, candidates, and state versions solely from definition plus events",()=>fresh(path=>{let before:any;withStore(path,s=>{s.obligations.create(input());s.obligations.append(event(1,{type:"reassigned",from:ada,to:bob}));before={snapshot:s.obligations.snapshot("o1"),candidate:s.obligations.candidates("bob")[0]};});withStore(path,s=>{expect(s.obligations.snapshot("o1")).toEqual(before.snapshot);expect(s.obligations.candidates("bob")[0]).toEqual(before.candidate);expect(s.obligations.events("o1")).toHaveLength(2);});}));
  test("priority ordering is exact and deterministic at equal priority",()=>fresh(path=>withStore(path,s=>{for(const [id,priority] of [["z","normal"],["a","important"],["u","urgent"]] as const)s.obligations.create(input({id,sourceActId:`act-${id}`,priority,idempotencyKey:`create-${id}`}));const cs=s.obligations.candidates("ada");expect(cs.map(x=>x.priority).sort((a,b)=>b-a)).toEqual([110,105,100]);const tied=pack({mandatoryHeader:[],peerFraming:[],candidates:cs.filter(x=>x.priority===105).concat([{...cs.find(x=>x.priority===105)!,key:"obligation:00",dedupeKey:"obligation:00"}]),targetChars:10_000});expect(tied.selected.map(x=>x.candidate.key)).toEqual([...tied.selected.map(x=>x.candidate.key)].sort());})));
  test("injected failure at every batch write boundary leaves no fragment",()=>{for(const [i,table] of ["messages","obligations","obligation_events","clearances","clearance_events","message_acts","hazard_notices","message_deliveries","obligation_dependencies","feature_events","semantic_batches"].entries())fresh(path=>withStore(path,s=>{const raw=new Database(path);raw.exec(`CREATE TRIGGER fail_p2 BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);raw.close();const acts:any[]=[{key:"q",type:"question",text:"Q"},{key:"p",type:"promise",text:"P",mode:"perform",condition:{text:"after Q",handling:"manual"}},{key:"g",type:"grant",text:"G",scopeText:"scope"},{key:"h",type:"hazard",text:"H",subject:"file"}];throws(()=>s.obligations.createBatch({senderSessionId:"ada",senderName:"Ada",recipientSessionId:"bob",recipientName:"Bob",acts,dependencies:[{sourceKey:"q",targetKey:"p",effect:"activate"}],idempotencyKey:`fault-${i}`,nowMs:1}),"storage");expect(s.recent(10)).toEqual([]);expect(s.obligations.all()).toEqual([]);expect(s.obligations.clearanceSnapshot("missing")).toBeNull();}));});
});
