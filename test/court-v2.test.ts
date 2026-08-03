import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  actAgreement, alignActs, categoricalAgreement, evaluateGate, seededSample, sha256, spanOverlap, validateAnnotations,
  type Act, type Annotation, type Evidence, type SourceMessage,
} from "./tools/court-v2.ts";

const BODY = "Ask Rowan now. I will not touch emit.ts until you reply.";
const source = new Map<number, SourceMessage>([[1, { id: 1, body: BODY }]]);
const ev = (quote: string, confidence: "high"|"medium"|"low" = "high"): Evidence => {
  const start = BODY.indexOf(quote);
  return { confidence, spans: [{ messageId: 1, start, end: start + quote.length, quote }] };
};
const act = (over: Partial<Act> = {}): Act => ({
  id: "a1", type: "question", author: "sender", recipients: ["Rowan"],
  responsibility: { kind: "assigned", actor: "Rowan" }, evidence: ev("Ask Rowan now."), ...over,
});
const valid = (): Annotation[] => [{
  id: 1,
  acts: [act()], hazards: [], provenance: [], declarations: [], responses: [],
  priorities: [{ recipient: "Rowan", value: "important", evidence: ev("Ask Rowan now.") }],
  actOutcomes: [{actId:"a1",value:"unassessable",evidence:{...ev("Ask Rowan now."),ambiguity:"No later response is present."}}], sourceCaveats: [],
}];
const errors = (mutate: (x: any) => void, ids = [1]): string[] => {
  const x: any = structuredClone(valid()); mutate(x);
  return validateAnnotations(x, source, ids).map((d) => `${d.path}: ${d.message}`);
};

describe("v2 annotation validator rejects data that would corrupt scoring", () => {
  test("accepts a complete valid annotation", () => expect(validateAnnotations(valid(), source, [1])).toEqual([]));
  test("top level must be an array", () => expect(validateAnnotations({}, source, [1])[0]?.message).toContain("array"));
  test("requires every assigned id", () => expect(validateAnnotations([], source, [1])[0]?.message).toBe("missing id 1"));
  test("rejects unexpected and duplicate ids", () => {
    const x = [...valid(), ...valid(), ...valid()]; x[2]!.id = 2;
    const d = validateAnnotations(x, source, [1]).map((v) => v.message);
    expect(d).toContain("unexpected id"); expect(d).toContain("duplicate id"); expect(d).toContain("source message not found");
  });
  test.each(["acts","hazards","provenance","declarations","responses","priorities","actOutcomes","sourceCaveats"])("requires the %s array", (field) => {
    expect(errors((x) => delete x[0][field]).join(" ")).toContain(`${field}: required array`);
  });
  test("span offsets must be in bounds, nonempty, and exact", () => {
    expect(errors((x) => x[0].acts[0].evidence.spans[0].end = 999).join(" ")).toContain("out of bounds");
    expect(errors((x) => x[0].acts[0].evidence.spans[0].quote = "wrong").join(" ")).toContain("body.slice");
    expect(errors((x) => x[0].acts[0].evidence.spans = []).join(" ")).toContain("at least one");
  });
  test("acts cite their own message while outcomes may cite later evidence", () => {
    const sources = new Map(source); sources.set(2,{id:2,body:"Done."});
    const x:any=structuredClone(valid());
    x[0].acts[0].evidence.spans[0]={messageId:2,start:0,end:5,quote:"Done."};
    expect(validateAnnotations(x,sources,[1]).map((v)=>v.message)).toContain("record must cite the message being classified");
    x[0].acts[0].evidence=ev("Ask Rowan now.");
    x[0].actOutcomes=[{actId:"a1",value:"fulfilled",evidence:{confidence:"high",spans:[{messageId:2,start:0,end:5,quote:"Done."}]}}];
    expect(validateAnnotations(x,sources,[1])).toEqual([]);
  });
  test("directed participants and priority cannot drift from source attribution",()=>{
    const attributed=new Map<number,SourceMessage>([[1,{id:1,body:BODY,from:"sender",to:"Rowan"}]]);
    expect(validateAnnotations(valid(),attributed,[1])).toEqual([]);
    const x:any=structuredClone(valid());x[0].acts[0].author="other";x[0].acts[0].recipients=[];x[0].priorities=[];
    const d=validateAnnotations(x,attributed,[1]).map(v=>v.message).join(" ");
    expect(d).toContain("stored source author");expect(d).toContain("at least one recipient");expect(d).toContain("exactly one recipient priority");
  });
  test("outcome chronology distinguishes observations from missing observations",()=>{
    expect(errors(x=>x[0].actOutcomes[0].value="fulfilled").join(" ")).toContain("requires later corpus evidence");
    const sources=new Map(source);sources.set(2,{id:2,body:"No answer."});const x:any=structuredClone(valid());
    x[0].actOutcomes[0].evidence={confidence:"high",ambiguity:"Still unknown.",spans:[{messageId:2,start:0,end:10,quote:"No answer."}]};
    expect(validateAnnotations(x,sources,[1]).map(v=>v.message).join(" ")).toContain("must cite its own act");
  });
  test("confidence is closed, not free text", () => expect(errors((x) => x[0].acts[0].evidence.confidence = "certain").join(" ")).toContain("invalid confidence"));
  test("act ids are nonempty and unique within a message", () => {
    expect(errors((x) => x[0].acts[0].id = "").join(" ")).toContain("nonempty and unique");
    expect(errors((x) => x[0].acts.push({...x[0].acts[0]})).join(" ")).toContain("nonempty and unique");
  });
  test("assigned responsibility requires an actor and other kinds forbid one", () => {
    expect(errors((x) => delete x[0].acts[0].responsibility.actor).join(" ")).toContain("actor is required");
    expect(errors((x) => x[0].acts[0].responsibility = {kind:"none",actor:"Rowan"}).join(" ")).toContain("actor is required only");
  });
  test("promise mode is required exactly on promises", () => {
    expect(errors((x) => x[0].acts[0].type = "promise").join(" ")).toContain("promise requires");
    expect(errors((x) => x[0].acts[0].commitmentMode = "perform").join(" ")).toContain("only to promise");
    expect(errors((x) => { x[0].acts[0].type="promise"; x[0].acts[0].commitmentMode="refrain"; })).toEqual([]);
  });
  test("correction subtype is required exactly on corrections", () => {
    expect(errors((x) => x[0].acts[0].type="correction").join(" ")).toContain("correction requires");
    expect(errors((x) => x[0].acts[0].correctionType="self_erratum").join(" ")).toContain("only to correction");
  });
  test("conditions and anchors use closed discriminants", () => {
    expect(errors((x) => x[0].acts[0].condition={handling:"eventually",text:"if"}).join(" ")).toContain("invalid condition");
    expect(errors((x) => x[0].acts[0].anchors=[{kind:"url",value:"x"}]).join(" ")).toContain("invalid anchor");
  });
  test("automatic conditions require a typed anchor",()=>expect(errors((x)=>x[0].acts[0].condition={handling:"automatic",text:"when landed"}).join(" ")).toContain("requires a typed anchor"));
  test("grants require structured scope, not scope hidden only in prose",()=>expect(errors((x)=>x[0].acts[0].type="grant").join(" ")).toContain("structured scope"));
  test("hazards, record ids, constraints and caveats cannot be empty shells",()=>{
    expect(errors((x)=>x[0].hazards=[{id:"h",subject:"",evidence:ev("Ask Rowan now.")}]).join(" ")).toContain("requires a subject");
    expect(errors((x)=>x[0].provenance=[{id:"",kind:"inferred_signal",summary:"x",evidence:ev("Ask Rowan now.")}]).join(" ")).toContain("record id");
    expect(errors((x)=>x[0].acts[0].constraints=[""]).join(" ")).toContain("nonempty strings");
    expect(errors((x)=>x[0].sourceCaveats=[""]).join(" ")).toContain("nonempty strings");
  });
  test("one recipient cannot have two competing priorities",()=>expect(errors((x)=>x[0].priorities.push({...x[0].priorities[0]})).join(" ")).toContain("priority must be unique"));
  test("declarations cannot point at a missing act", () => {
    expect(errors((x) => x[0].declarations=[{id:"d",appliesToActId:"absent",declared:"FYI",conflict:true,evidence:ev("Ask Rowan now.")}]).join(" ")).toContain("invalid declaration");
  });
  test("responses and priorities use closed values", () => {
    expect(errors((x) => x[0].responses=[{respondsToMessageId:0,disposition:"liked",evidence:ev("Ask Rowan now.")}]).join(" ")).toContain("invalid response");
    expect(errors((x) => x[0].priorities[0].value="critical").join(" ")).toContain("invalid priority");
  });
  test("outcomes require a real act, valid value, evidence, and uniqueness", () => {
    expect(errors((x)=>x[0].actOutcomes=[{actId:"missing",value:"fulfilled",evidence:ev("Ask Rowan now.")}]).join(" ")).toContain("invalid act outcome");
    expect(errors((x)=>x[0].actOutcomes=[{actId:"a1",value:"none",evidence:ev("Ask Rowan now.")}]).join(" ")).toContain("invalid act outcome");
    expect(errors((x)=>x[0].actOutcomes=[{actId:"a1",value:"fulfilled"}]).join(" ")).toContain("evidence must be an object");
    expect(errors((x)=>x[0].actOutcomes=[{actId:"a1",value:"fulfilled",evidence:ev("Ask Rowan now.")},{actId:"a1",value:"unresolved",evidence:ev("Ask Rowan now.")}]).join(" ")).toContain("only one outcome");
  });
});

describe("deterministic holdout", () => {
  test("same population and seed is stable", () => expect(seededSample([1,2,3,4,5],3,7)).toEqual(seededSample([1,2,3,4,5],3,7)));
  test("does not mutate population", () => { const p=[1,2,3]; seededSample(p,2,1); expect(p).toEqual([1,2,3]); });
  test("contains no duplicates or outsiders", () => { const s=seededSample([1,2,3,4,5],5,9); expect(new Set(s).size).toBe(5); expect(s.every((x)=>x>=1&&x<=5)).toBe(true); });
  test("rejects impossible sizes", () => { expect(()=>seededSample([1],2,1)).toThrow(); expect(()=>seededSample([1],-1,1)).toThrow(); });
});

describe("act alignment", () => {
  const a = (id:string, start:number, end:number, type:Act["type"]="inform"):Act => ({...act(),id,type,evidence:{confidence:"high",spans:[{messageId:1,start,end,quote:BODY.slice(start,end)}]}});
  test("overlap is measured in source units", () => expect(spanOverlap(a("a",0,10).evidence,a("b",5,15).evidence)).toBe(5));
  test("never aligns disjoint acts", () => expect(alignActs([a("a",0,3)],[a("b",5,8)])).toEqual([]));
  test("type cannot influence boundary alignment", () => expect(alignActs([a("a",0,10,"request")],[a("b",0,10,"promise")])).toEqual([[0,0]]));
  test("finds maximum total overlap rather than greedy first match", () => {
    const left=[a("l1",0,10),a("l2",10,20)]; const right=[a("r1",0,20),a("r2",0,9)];
    expect(alignActs(left,right)).toEqual([[0,1],[1,0]]);
  });
  test("refuses exponential inputs beyond its declared bound", () => expect(()=>alignActs([],Array.from({length:21},(_,i)=>a(`${i}`,0,1)))).toThrow());
});

describe("agreement metrics", () => {
  test("confusion matrix, support, raw agreement and kappa are independently derived", () => {
    const m=categoricalAgreement([["a","a"],["a","b"],["b","b"],["b","b"]]);
    expect(m.applicable).toBe(4); expect(m.support).toEqual({a:2,b:2});
    expect(m.confusion).toEqual({a:{a:1,b:1},b:{b:2}}); expect(m.rawAgreement).toBe(0.75);
    expect(m.kappa).toBeCloseTo(0.5);
  });
  test("null pairs are excluded, not turned into a category", () => {
    const m=categoricalAgreement([[null,"a"],["a",null],["a","a"]]);
    expect(m.applicable).toBe(1); expect(m.support).toEqual({a:1});
  });
  test("no applicable pairs and no-variance kappa are explicit", () => {
    expect(categoricalAgreement([[null,null]]).kappaUndefinedReason).toBe("no applicable pairs");
    const same=categoricalAgreement([["a","a"],["a","a"]]);
    expect(same.rawAgreement).toBe(1); expect(same.kappa).toBeNull(); expect(same.kappaUndefinedReason).toContain("no variance");
  });
  test("act boundary credit is separate from type credit", () => {
    const p=[act({id:"p",type:"request"})]; const r=[act({id:"r",type:"promise",commitmentMode:"perform"})];
    const m=actAgreement(p,r); expect(m.boundary.f1).toBe(1); expect(m.type.f1).toBe(0);
  });
  test("unmatched acts affect directional precision and recall", () => {
    const p=[act({id:"p1"}),act({id:"p2",evidence:ev("I will not touch emit.ts")})];
    const r=[act({id:"r1"})]; const m=actAgreement(p,r);
    expect(m.type.precision).toBe(1); expect(m.type.recall).toBe(0.5); expect(m.type.f1).toBeCloseTo(2/3);
  });
});

describe("P1 gate is executable rather than editorial", () => {
  test("passes qualifying dimensions and lists scarce ones as provisional", () => {
    const g=evaluateGate({dimensions:[{name:"priority",applicable:10,rawAgreement:0.9,kappa:0.7},{name:"clearance",applicable:2,rawAgreement:1,kappa:null}],actTypeF1:0.8,regressionPassed:true});
    expect(g.passed).toBe(true); expect(g.provisional).toEqual(["clearance"]);
  });
  test("each threshold fails independently at the boundary", () => {
    const g=evaluateGate({dimensions:[
      {name:"raw",applicable:5,rawAgreement:0.799,kappa:0.9},
      {name:"kappa",applicable:5,rawAgreement:0.9,kappa:0.599},
      {name:"structural",applicable:5,rawAgreement:1,kappa:1,structural:true,directionalDisagreements:3},
    ],actTypeF1:0.799,regressionPassed:false});
    expect(g.passed).toBe(false); expect(g.failures).toHaveLength(5);
  });
  test("undefined no-variance kappa does not fail a dimension with enough raw agreement", () => {
    expect(evaluateGate({dimensions:[{name:"x",applicable:5,rawAgreement:0.8,kappa:null}],actTypeF1:1,regressionPassed:true}).passed).toBe(true);
  });
  test("an explicit P2 deferral is preserved and excluded from pass thresholds", () => {
    const g=evaluateGate({dimensions:[{name:"anchors",applicable:20,rawAgreement:0.1,kappa:0}],actTypeF1:1,regressionPassed:true,deferredDimensions:["anchors"]});
    expect(g.passed).toBe(true); expect(g.deferred).toEqual(["anchors"]); expect(g.failures).toEqual([]);
  });
});

describe("frozen inputs", () => {
  const root = `${import.meta.dir}/../plans/court-audit`;
  const manifest = JSON.parse(readFileSync(`${root}/audit-v2-manifest.json`,"utf8"));
  test("rubric and corpus hashes match the freeze", () => {
    expect(sha256(readFileSync(`${root}/rubric-v2.md`,"utf8"))).toBe(manifest.rubricSha256);
    expect(sha256(readFileSync(`${root}/audit-source.json`,"utf8"))).toBe(manifest.sourceSha256);
  });
  test("analysis, regression, holdout and exclusions are disjoint where required", () => {
    const analysed=new Set(manifest.analysedIds); const excluded=new Set(manifest.excluded.map((x:any)=>x.id));
    const regression=new Set(manifest.regressionIds); const holdout=new Set(manifest.reviewerHoldout.selectedIds);
    expect(analysed.size).toBe(45); expect(excluded.size).toBe(5); expect(regression.size).toBe(15); expect(holdout.size).toBe(15);
    expect([...excluded].some((id)=>analysed.has(id))).toBe(false);
    expect([...holdout].some((id)=>regression.has(id))).toBe(false);
  });
  test("holdout is exactly the recorded algorithm output", () => {
    const h=manifest.reviewerHoldout;
    expect(seededSample(h.orderedPopulation,15,h.seed)).toEqual(h.selectedIds);
  });
  test("generated P1 artifacts agree on version and record a passing executable gate",()=>{
    const regression=JSON.parse(readFileSync(`${root}/audit-v2-regression.json`,"utf8"));
    const agreement=JSON.parse(readFileSync(`${root}/audit-v2-agreement.json`,"utf8"));
    expect(regression.rubricVersion).toBe(manifest.rubricVersion);expect(regression.passed).toBe(true);
    expect(agreement.rubricVersion).toBe(manifest.rubricVersion);expect(agreement.gate.passed).toBe(true);
    expect([...agreement.gate.deferred].sort()).toEqual(Object.keys(manifest.deferredFromP2).sort());
  });
});

describe("primary pass is complete and closes every known v1 hole", () => {
  const root=`${import.meta.dir}/../plans/court-audit`;
  const sourceRows=JSON.parse(readFileSync(`${root}/audit-source.json`,"utf8"));
  const sources=new Map<number,SourceMessage>(sourceRows.map((x:SourceMessage)=>[x.id,x]));
  const manifest=JSON.parse(readFileSync(`${root}/audit-v2-manifest.json`,"utf8"));
  const primary=JSON.parse(readFileSync(`${root}/audit-v2-primary.json`,"utf8")) as Annotation[];
  const m=(id:number)=>primary.find((x)=>x.id===id)!;
  const types=(id:number)=>m(id).acts.map((x)=>x.type);
  test("all 45 labels pass the same strict validator used for the holdout",()=>expect(validateAnnotations(primary,sources,manifest.analysedIds)).toEqual([]));
  test("#36 separates clearance, question and promise",()=>expect(types(36)).toEqual(expect.arrayContaining(["grant","question","promise"])));
  test("#40 records a third-party report without inventing its act",()=>{expect(m(40).provenance.some((x)=>x.kind==="reported_third_party")).toBe(true);expect(types(40)).not.toContain("request");});
  test("#97 records forbearance as refrain",()=>expect(m(97).acts.find((x)=>x.type==="promise")?.commitmentMode).toBe("refrain"));
  test("#110 keeps hazard independent of request and promise",()=>{expect(m(110).hazards.length).toBeGreaterThan(0);expect(types(110)).toEqual(expect.arrayContaining(["request","promise"]));});
  test("#112 attaches constraints to clearance",()=>{const g=m(112).acts.find((x)=>x.type==="grant");expect(g?.constraints?.length).toBeGreaterThanOrEqual(2);});
  test("#141 response linkage does not resolve its own question",()=>{const q=m(141).acts.find((a)=>a.type==="question");const o=m(141).actOutcomes.find((x)=>x.actId===q?.id);expect(m(141).responses.length).toBeGreaterThan(0);expect(o?.value).toBe("unassessable");expect(o?.evidence.spans.every((s)=>s.messageId===141)).toBe(true);});
  test("#146 preserves branches and refrain separately",()=>{expect(m(146).acts.find((x)=>x.type==="question")?.condition?.branch).toContain("stale claim");expect(m(146).acts.find((x)=>x.type==="promise")?.commitmentMode).toBe("refrain");});
  test("#155 is a transport erratum, not supersession",()=>{expect(m(155).acts[0]?.correctionType).toBe("self_erratum");expect(m(155).sourceCaveats.join(" ")).toContain("transport");});
  test("#161 preserves assigned and orphaned work",()=>expect(m(161).acts.map((x)=>x.responsibility.kind)).toEqual(expect.arrayContaining(["assigned","unassigned"])));
  test("#249 preserves sender declaration conflict without manufacturing a request",()=>{expect(m(249).declarations.some((x)=>x.conflict)).toBe(true);expect(types(249)).not.toContain("request");expect(m(249).provenance.some((x)=>x.kind==="inferred_signal")).toBe(true);});
  test("#262 conditional offer includes refrain promise",()=>expect(m(262).acts.find((x)=>x.type==="promise")?.commitmentMode).toBe("refrain"));
  test("#284/#289/#295 preserve return, withdrawal and orphan separately",()=>{expect(types(284)).toContain("handoff");expect(m(289).acts.some((x)=>x.type==="promise"&&x.commitmentMode==="refrain")).toBe(true);expect(m(295).acts.some((x)=>x.responsibility.kind==="unassigned")).toBe(true);});
  test("#399 warning is independent of behaviour correction",()=>{expect(m(399).hazards.length).toBeGreaterThan(0);expect(types(399)).toContain("correction");});
  test("every annotation has exactly one recipient priority",()=>expect(primary.every((x)=>x.priorities.length===1)).toBe(true));
});
