import { readFileSync } from "node:fs";
import { actAgreement, categoricalAgreement, evaluateGate, validateAnnotations, type Annotation, type GateDimension, type SourceMessage } from "./court-v2.ts";
const ROOT=`${import.meta.dir}/../../plans/court-audit`;
const read=<T>(name:string):T=>JSON.parse(readFileSync(`${ROOT}/${name}`,"utf8"));
const manifest=read<any>("audit-v2-manifest.json");
const source=read<SourceMessage[]>("audit-source.json");
const allPrimary=read<Annotation[]>("audit-v2-primary.json");
const reviewer=read<Annotation[]>("audit-v2-holdout-review.json");
const ids=manifest.reviewerHoldout.selectedIds as number[];
const sourceMap=new Map(source.map(x=>[x.id,x]));
const diagnostics=validateAnnotations(reviewer,sourceMap,ids);
if(diagnostics.length) throw new Error(`holdout invalid:\n${diagnostics.map(x=>`${x.path}: ${x.message}`).join("\n")}`);
const primary=ids.map(id=>allPrimary.find(x=>x.id===id)!); const review=ids.map(id=>reviewer.find(x=>x.id===id)!);
let boundary={tp:0,fp:0,fn:0}; let type={tp:0,fp:0,fn:0}; const aligned:Array<{id:number;p:number;r:number}>=[];
for(let i=0;i<ids.length;i++){
  const a=actAgreement(primary[i]!.acts,review[i]!.acts);
  for(const k of ["tp","fp","fn"] as const){boundary[k]+=a.boundary[k];type[k]+=a.type[k];}
  aligned.push(...a.aligned.map(([p,r])=>({id:ids[i]!,p,r})));
}
const metric=(x:{tp:number;fp:number;fn:number})=>{const precision=x.tp+x.fp?x.tp/(x.tp+x.fp):1;const recall=x.tp+x.fn?x.tp/(x.tp+x.fn):1;return {...x,precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0};};
const dimensions:Record<string,ReturnType<typeof categoricalAgreement>>={};
const dimensionPairs:Record<string,ReadonlyArray<readonly[string|null,string|null]>>={};
dimensionPairs.priority=primary.map((p,i)=>[p.priorities[0]?.value??null,review[i]!.priorities[0]?.value??null]);
const alignedPairs=(pick:(a:any)=>string|null)=>aligned.map(x=>[pick(primary.find(a=>a.id===x.id)!.acts[x.p]),pick(review.find(a=>a.id===x.id)!.acts[x.r])] as const);
dimensionPairs.author=alignedPairs(a=>a.author??null);
dimensionPairs.recipients=alignedPairs(a=>Array.isArray(a.recipients)?[...a.recipients].sort().join("|"):null);
dimensionPairs.responsibility=alignedPairs(a=>a.responsibility?.kind??null);
dimensionPairs.commitmentMode=alignedPairs(a=>a.type==="promise"?(a.commitmentMode??"missing"):null);
dimensionPairs.conditionHandling=alignedPairs(a=>a.condition?.handling??"none");
dimensionPairs.constraintsPresence=alignedPairs(a=>(a.constraints?.length??0)?"present":"absent");
dimensionPairs.anchorPresence=alignedPairs(a=>(a.anchors?.length??0)||(a.condition?.anchors?.length??0)?"present":"absent");
dimensionPairs.correctionType=alignedPairs(a=>a.type==="correction"?(a.correctionType??"missing"):null);
dimensionPairs.evidenceConfidence=alignedPairs(a=>a.evidence?.confidence??null);
dimensionPairs.clearancePresence=primary.map((p,i)=>[p.acts.some(a=>a.type==="grant")?"present":"absent",review[i]!.acts.some(a=>a.type==="grant")?"present":"absent"]);
dimensionPairs.hazardPresence=primary.map((p,i)=>[p.hazards.length?"present":"absent",review[i]!.hazards.length?"present":"absent"]);
dimensionPairs.provenancePresence=primary.map((p,i)=>[p.provenance.length?"present":"absent",review[i]!.provenance.length?"present":"absent"]);
dimensionPairs.declarationPresence=primary.map((p,i)=>[p.declarations.length?"present":"absent",review[i]!.declarations.length?"present":"absent"]);
dimensionPairs.responsePresence=primary.map((p,i)=>[p.responses.length?"present":"absent",review[i]!.responses.length?"present":"absent"]);
dimensionPairs.outcomePresence=primary.map((p,i)=>[p.actOutcomes.length?"present":"absent",review[i]!.actOutcomes.length?"present":"absent"]);
for(const [name,pairs] of Object.entries(dimensionPairs))dimensions[name]=categoricalAgreement(pairs);
const structural=new Set(["responsibility","conditionHandling","constraintsPresence","clearancePresence","declarationPresence","responsePresence"]);
const alignedDimensions=new Set(["author","recipients","responsibility","commitmentMode","conditionHandling","constraintsPresence","anchorPresence","correctionType","evidenceConfidence"]);
const gateDimensions:GateDimension[]=Object.entries(dimensions).map(([name,m])=>({
  name,applicable:m.applicable,rawAgreement:m.rawAgreement,kappa:m.kappa,
  structural:structural.has(name),
  directionalDisagreements:structural.has(name)
    ? new Set((dimensionPairs[name]??[]).flatMap(([a,b],index)=>a===b?[]:[alignedDimensions.has(name)?aligned[index]!.id:ids[index]!])).size : 0,
}));
const act=metric(type); const boundaryMetric=metric(boundary);
const regression=read<any>("audit-v2-regression.json");
const gate=evaluateGate({dimensions:gateDimensions,actTypeF1:act.f1,regressionPassed:regression.passed,deferredDimensions:Object.keys(manifest.deferredFromP2??{})});
const signature=(x:Annotation)=>JSON.stringify({acts:x.acts.map(a=>a.type).sort(),hazards:x.hazards.length,provenance:x.provenance.map(p=>p.kind).sort(),declarations:x.declarations.length,responses:x.responses.map(r=>`${r.respondsToMessageId}:${r.disposition}`).sort(),priority:x.priorities.map(p=>p.value).sort()});
const exact=primary.filter((p,i)=>signature(p)===signature(review[i]!)).length;
const artifact={rubricVersion:manifest.rubricVersion,holdoutIds:ids,actBoundary:boundaryMetric,actType:act,dimensions,wholeMessageExact:{matched:exact,total:ids.length,rate:exact/ids.length},gate};
await Bun.write(`${ROOT}/audit-v2-agreement.json`,JSON.stringify(artifact,null,2)+"\n");
const pct=(x:number|null)=>x===null?"n/a":`${(x*100).toFixed(1)}%`;
const rows=Object.entries(dimensions).map(([n,m])=>`| ${n} | ${m.applicable} | ${pct(m.rawAgreement)} | ${m.kappa===null?`n/a (${m.kappaUndefinedReason})`:m.kappa.toFixed(3)} |`).join("\n");
const report=`# Court rubric v2 — P1 report\n\n*Generated from immutable raw labels; adjudication is not included.*\n\n## Result\n\n**${gate.passed?"PASS":"FAIL"}**\n\n- act boundary F1: ${boundaryMetric.f1.toFixed(3)}\n- act type F1: ${act.f1.toFixed(3)}\n- whole-message exact: ${exact}/${ids.length} (secondary only)\n- original-15 regression: ${regression.passed?"PASS":"FAIL"}\n\n## Per-dimension agreement\n\n| dimension | applicable | raw | kappa |\n|---|---:|---:|---:|\n${rows}\n\n## Gate findings\n\n${gate.failures.length?gate.failures.map(x=>`- FAIL: ${x}`).join("\n"):"- No failures."}\n${gate.provisional.length?`\nProvisional for low holdout support: ${gate.provisional.join(", ")}.`:""}\n\nSupport counts for the full 45-message primary corpus are preserved in \`audit-v2-regression.json\`.\n`;
const deferredNote=gate.deferred.length?`\nExplicitly deferred from P2: ${gate.deferred.join(", ")}. See audit-v2-manifest.json for reasons.\n`:"";
const finalReport=report.replace("# Court rubric v2 — P1 report","# Court rubric v2 - P1 report").replace("\n\nSupport counts",`${deferredNote}\nSupport counts`);
await Bun.write(`${ROOT}/audit-v2-report.md`,finalReport);
console.log(`P1 ${gate.passed?"PASS":"FAIL"}; act type F1 ${act.f1.toFixed(3)}`);
