import { readFileSync } from "node:fs";
import type { Annotation } from "./court-v2.ts";
const ROOT=`${import.meta.dir}/../../plans/court-audit`;
const primary=JSON.parse(readFileSync(`${ROOT}/audit-v2-primary.json`,"utf8")) as Annotation[];
const manifest=JSON.parse(readFileSync(`${ROOT}/audit-v2-manifest.json`,"utf8"));
const byId=new Map(primary.map(x=>[x.id,x]));
const has=(id:number,p:(x:Annotation)=>boolean)=>p(byId.get(id)!);
const checks:Array<[string,number,boolean]> = [
  ["clearance-question-promise-separated",36,has(36,x=>["grant","question","promise"].every(t=>x.acts.some(a=>a.type===t)))],
  ["reported-third-party-is-provenance",40,has(40,x=>x.provenance.some(p=>p.kind==="reported_third_party")&&!x.acts.some(a=>a.type==="request"))],
  ["forbearance-is-refrain",97,has(97,x=>x.acts.some(a=>a.type==="promise"&&a.commitmentMode==="refrain"))],
  ["hazard-independent-of-acts",110,has(110,x=>x.hazards.length>0&&x.acts.some(a=>a.type==="request")&&x.acts.some(a=>a.type==="promise"))],
  ["constraint-attached-to-clearance",112,has(112,x=>(x.acts.find(a=>a.type==="grant")?.constraints?.length??0)>0)],
  ["response-not-borrowed-as-own-outcome",141,has(141,x=>{const q=x.acts.find(a=>a.type==="question");const o=x.actOutcomes.find(o=>o.actId===q?.id);return x.responses.length>0&&o?.value==="unassessable"&&o.evidence.spans.every(s=>s.messageId===141);})],
  ["branched-question-and-refrain",146,has(146,x=>!!x.acts.find(a=>a.type==="question")?.condition?.branch&&x.acts.some(a=>a.type==="promise"&&a.commitmentMode==="refrain"))],
  ["transport-erratum",155,has(155,x=>x.acts[0]?.correctionType==="self_erratum"&&x.sourceCaveats.length>0)],
  ["owned-and-orphaned-actions",161,has(161,x=>x.acts.some(a=>a.responsibility.kind==="assigned")&&x.acts.some(a=>a.responsibility.kind==="unassigned"))],
  ["sender-declaration-local-conflict",249,has(249,x=>x.declarations.some(d=>d.conflict)&&x.provenance.some(p=>p.kind==="inferred_signal")&&!x.acts.some(a=>a.type==="request"))],
  ["conditional-offer-decomposed",262,has(262,x=>x.acts.some(a=>a.type==="promise"&&a.commitmentMode==="refrain")&&x.acts.some(a=>a.type==="proposal"))],
  ["return-is-handoff",284,has(284,x=>x.acts.some(a=>a.type==="handoff"))],
  ["self-and-implementation-correction-separated",289,has(289,x=>new Set(x.acts.filter(a=>a.type==="correction").map(a=>a.correctionType)).size>=2)],
  ["withdrawal-and-orphan-preserved",295,has(295,x=>x.acts.some(a=>a.type==="promise"&&a.commitmentMode==="refrain")&&x.acts.some(a=>a.responsibility.kind==="unassigned"))],
  ["behaviour-correction-and-hazard-separated",399,has(399,x=>x.acts.some(a=>a.type==="correction")&&x.hazards.length>0)],
];
const support={
  messages:primary.length,
  acts:Object.fromEntries([...new Set(primary.flatMap(x=>x.acts.map(a=>a.type)))].sort().map(t=>[t,primary.flatMap(x=>x.acts).filter(a=>a.type===t).length])),
  responsibility:Object.fromEntries(["assigned","unassigned","none"].map(k=>[k,primary.flatMap(x=>x.acts).filter(a=>a.responsibility.kind===k).length])),
  commitmentMode:Object.fromEntries(["perform","refrain"].map(k=>[k,primary.flatMap(x=>x.acts).filter(a=>a.commitmentMode===k).length])),
  condition:Object.fromEntries(["automatic","resurface_on_related_event","manual"].map(k=>[k,primary.flatMap(x=>x.acts).filter(a=>a.condition?.handling===k).length])),
  constrainedActs:primary.flatMap(x=>x.acts).filter(a=>(a.constraints?.length??0)>0).length,
  clearanceActs:primary.flatMap(x=>x.acts).filter(a=>a.type==="grant").length,
  hazardMessages:primary.filter(x=>x.hazards.length>0).length,
  provenanceRecords:primary.flatMap(x=>x.provenance).length,
  declarationRecords:primary.flatMap(x=>x.declarations).length,
  responseRecords:primary.flatMap(x=>x.responses).length,
  outcomeRecords:primary.flatMap(x=>x.actOutcomes).length,
  priorities:primary.flatMap(x=>x.priorities).reduce((a,p)=>(a[p.value]=(a[p.value]??0)+1,a),{} as Record<string,number>),
  dimensionSupport:{
    acts:{positive:primary.flatMap(x=>x.acts).length,applicable:primary.length,missing:0},
    responsibility:{positive:primary.flatMap(x=>x.acts).filter(a=>a.responsibility.kind!=="none").length,applicable:primary.flatMap(x=>x.acts).length,missing:0},
    commitmentMode:{positive:primary.flatMap(x=>x.acts).filter(a=>a.commitmentMode!==undefined).length,applicable:primary.flatMap(x=>x.acts).filter(a=>a.type==="promise").length,missing:0},
    condition:{positive:primary.flatMap(x=>x.acts).filter(a=>a.condition!==undefined).length,applicable:primary.flatMap(x=>x.acts).length,missing:0},
    constraints:{positive:primary.flatMap(x=>x.acts).filter(a=>(a.constraints?.length??0)>0).length,applicable:primary.flatMap(x=>x.acts).length,missing:0},
    clearance:{positive:primary.flatMap(x=>x.acts).filter(a=>a.type==="grant").length,applicable:primary.length,missing:0},
    hazard:{positive:primary.filter(x=>x.hazards.length>0).length,applicable:primary.length,missing:0},
    correction:{positive:primary.flatMap(x=>x.acts).filter(a=>a.type==="correction").length,applicable:primary.flatMap(x=>x.acts).length,missing:0},
    provenance:{positive:primary.filter(x=>x.provenance.length>0).length,applicable:primary.length,missing:0},
    senderDeclaration:{positive:primary.filter(x=>x.declarations.length>0).length,applicable:primary.length,missing:0},
    responseLinkage:{positive:primary.filter(x=>x.responses.length>0).length,applicable:primary.length,missing:0},
    priority:{positive:primary.flatMap(x=>x.priorities).length,applicable:primary.length,missing:0},
    anchors:{positive:primary.flatMap(x=>x.acts).filter(a=>(a.anchors?.length??0)>0||(a.condition?.anchors?.length??0)>0).length,applicable:primary.flatMap(x=>x.acts).length,missing:0},
    confidence:{positive:primary.flatMap(x=>[...x.acts,...x.hazards,...x.provenance,...x.declarations,...x.responses,...x.priorities,...x.actOutcomes]).length,applicable:primary.flatMap(x=>[...x.acts,...x.hazards,...x.provenance,...x.declarations,...x.responses,...x.priorities,...x.actOutcomes]).length,missing:0},
  },
};
const artifact={rubricVersion:manifest.rubricVersion,regressionIds:manifest.regressionIds,checks:checks.map(([name,id,passed])=>({name,id,passed})),passed:checks.every(x=>x[2]),support};
await Bun.write(`${ROOT}/audit-v2-regression.json`,JSON.stringify(artifact,null,2)+"\n");
console.log(`regression ${artifact.passed?"PASS":"FAIL"}; ${checks.length} checks`);
