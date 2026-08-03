import { createHash } from "node:crypto";

export const ACT_TYPES = [
  "inform", "question", "request", "promise", "correction", "handoff", "grant", "proposal",
] as const;
export const CONFIDENCE = ["high", "medium", "low"] as const;
export const PRIORITIES = ["normal", "important", "urgent"] as const;
export const OUTCOMES = ["fulfilled", "violated", "unresolved", "unassessable", "none"] as const;
export const RESPONSES = ["acknowledge", "accept", "decline", "counter", "answer", "return", "revoke"] as const;

export interface SourceMessage { id: number; body: string; from?: string; to?: string }
export interface Span { messageId: number; start: number; end: number; quote: string }
export interface Evidence { spans: Span[]; confidence: typeof CONFIDENCE[number]; ambiguity?: string }
export interface Responsibility { kind: "assigned" | "unassigned" | "none"; actor?: string }
export interface Condition {
  handling: "automatic" | "resurface_on_related_event" | "manual";
  text: string;
  branch?: string;
  anchors?: Anchor[];
}
export interface Anchor { kind: "file" | "commit" | "work_item" | "test" | "message" | "other"; value: string }
export interface Act {
  id: string;
  type: typeof ACT_TYPES[number];
  author: string;
  recipients: string[];
  responsibility: Responsibility;
  evidence: Evidence;
  commitmentMode?: "perform" | "refrain";
  condition?: Condition;
  constraints?: string[];
  correctionType?: "self_erratum" | "peer_correction" | "implementation_correction";
  target?: string;
  anchors?: Anchor[];
}
export interface Hazard { id: string; subject: string; anchors?: Anchor[]; evidence: Evidence }
export interface ProvenanceRecord {
  id: string;
  kind: "reported_third_party" | "inferred_signal";
  actor?: string;
  actType?: string;
  summary: string;
  source?: string;
  evidence: Evidence;
}
export interface Declaration { id: string; appliesToActId?: string; declared: string; conflict: boolean; evidence: Evidence }
export interface Response { respondsToMessageId: number; disposition: typeof RESPONSES[number]; evidence: Evidence }
export interface Priority { recipient: string; value: typeof PRIORITIES[number]; evidence: Evidence }
export interface Annotation {
  id: number;
  acts: Act[];
  hazards: Hazard[];
  provenance: ProvenanceRecord[];
  declarations: Declaration[];
  responses: Response[];
  priorities: Priority[];
  actOutcomes: Array<{ actId:string; value: Exclude<typeof OUTCOMES[number],"none">; evidence:Evidence }>;
  sourceCaveats: string[];
}

export interface Diagnostic { path: string; message: string }

const oneOf = (value: unknown, allowed: readonly string[]): boolean =>
  typeof value === "string" && allowed.includes(value);
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Strict enough that malformed reviewer output cannot quietly enter scoring. */
export function validateAnnotations(
  raw: unknown,
  sources: ReadonlyMap<number, SourceMessage>,
  expectedIds: readonly number[],
): Diagnostic[] {
  const d: Diagnostic[] = [];
  if (!Array.isArray(raw)) return [{ path: "$", message: "annotations must be an array" }];
  const expected = new Set(expectedIds);
  const seen = new Set<number>();
  const evidence = (v: unknown, path: string, currentId: number, ownMessageOnly = true): void => {
    if (!object(v)) { d.push({ path, message: "evidence must be an object" }); return; }
    if (!oneOf(v.confidence, CONFIDENCE)) d.push({ path: `${path}.confidence`, message: "invalid confidence" });
    if (!Array.isArray(v.spans) || v.spans.length === 0) {
      d.push({ path: `${path}.spans`, message: "at least one decisive span is required" }); return;
    }
    for (let i = 0; i < v.spans.length; i++) {
      const s = v.spans[i]; const p = `${path}.spans[${i}]`;
      if (!object(s) || !Number.isInteger(s.messageId) || !Number.isInteger(s.start) || !Number.isInteger(s.end) || typeof s.quote !== "string") {
        d.push({ path: p, message: "span requires integer messageId/start/end and quote" }); continue;
      }
      const messageId = s.messageId as number; const spanSource = sources.get(messageId);
      if (!spanSource) { d.push({ path: p, message: "span source message not found" }); continue; }
      if (ownMessageOnly && messageId !== currentId) d.push({ path: p, message: "record must cite the message being classified" });
      const body = spanSource.body;
      const start = s.start as number; const end = s.end as number;
      if (start < 0 || end <= start || end > body.length) d.push({ path: p, message: "span is out of bounds or empty" });
      else if (body.slice(start, end) !== s.quote) d.push({ path: p, message: "quote does not equal body.slice(start,end)" });
    }
  };
  const anchors = (v: unknown, path: string): void => {
    if (v === undefined) return;
    if (!Array.isArray(v)) { d.push({ path, message: "anchors must be an array" }); return; }
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      if (!object(a) || !oneOf(a.kind, ["file","commit","work_item","test","message","other"]) || typeof a.value !== "string" || a.value === "")
        d.push({ path: `${path}[${i}]`, message: "invalid anchor" });
    }
  };
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]; const p = `$[${i}]`;
    if (!object(a) || !Number.isInteger(a.id)) { d.push({ path: p, message: "annotation requires integer id" }); continue; }
    const id = a.id as number; const source = sources.get(id);
    if (!expected.has(id)) d.push({ path: `${p}.id`, message: "unexpected id" });
    if (seen.has(id)) d.push({ path: `${p}.id`, message: "duplicate id" });
    seen.add(id);
    if (!source) { d.push({ path: `${p}.id`, message: "source message not found" }); continue; }
    const body = source.body;
    for (const field of ["acts","hazards","provenance","declarations","responses","priorities","actOutcomes","sourceCaveats"]) {
      if (!Array.isArray(a[field])) d.push({ path: `${p}.${field}`, message: "required array" });
    }
    const recordIds = new Set<string>();
    const recordId=(x:Record<string,unknown>,path:string):void=>{
      if(typeof x.id!=="string"||x.id===""||recordIds.has(x.id)) d.push({path:`${path}.id`,message:"record id must be nonempty and unique"});
      else recordIds.add(x.id);
    };
    for (let j = 0; j < (Array.isArray(a.acts) ? a.acts.length : 0); j++) {
      const x = a.acts[j]; const q = `${p}.acts[${j}]`;
      if (!object(x)) { d.push({ path: q, message: "act must be an object" }); continue; }
      if (typeof x.id !== "string" || x.id === "" || recordIds.has(x.id)) d.push({ path: `${q}.id`, message: "act id must be nonempty and unique" });
      else recordIds.add(x.id);
      if (!oneOf(x.type, ACT_TYPES)) d.push({ path: `${q}.type`, message: "invalid act type" });
      if (typeof x.author !== "string" || x.author === "") d.push({ path: `${q}.author`, message: "author required" });
      if (!Array.isArray(x.recipients) || x.recipients.length === 0 || x.recipients.some((r) => typeof r !== "string" || r === "")) d.push({ path: `${q}.recipients`, message: "at least one recipient is required" });
      else if(source.to!==undefined&&(x.recipients.length!==1||x.recipients[0]!==source.to)) d.push({path:`${q}.recipients`,message:"act recipients must match the directed source recipient"});
      if(source.from!==undefined&&x.author!==source.from)d.push({path:`${q}.author`,message:"act author must match the stored source author"});
      if (!object(x.responsibility) || !oneOf(x.responsibility.kind, ["assigned","unassigned","none"])) d.push({ path: `${q}.responsibility`, message: "invalid responsibility" });
      else if (x.responsibility.kind === "assigned" ? typeof x.responsibility.actor !== "string" || x.responsibility.actor === "" : x.responsibility.actor !== undefined) d.push({ path: `${q}.responsibility.actor`, message: "actor is required only for assigned responsibility" });
      if (x.type === "promise" && !oneOf(x.commitmentMode, ["perform","refrain"])) d.push({ path: `${q}.commitmentMode`, message: "promise requires commitmentMode" });
      if (x.type !== "promise" && x.commitmentMode !== undefined) d.push({ path: `${q}.commitmentMode`, message: "commitmentMode applies only to promise" });
      if (x.type === "correction" && !oneOf(x.correctionType, ["self_erratum","peer_correction","implementation_correction"])) d.push({ path: `${q}.correctionType`, message: "correction requires correctionType" });
      if (x.type !== "correction" && x.correctionType !== undefined) d.push({ path: `${q}.correctionType`, message: "correctionType applies only to correction" });
      if (x.condition !== undefined) {
        if (!object(x.condition) || !oneOf(x.condition.handling, ["automatic","resurface_on_related_event","manual"]) || typeof x.condition.text !== "string" || x.condition.text === "") d.push({ path: `${q}.condition`, message: "invalid condition" });
        else {
          anchors(x.condition.anchors, `${q}.condition.anchors`);
          if(x.condition.handling==="automatic"&&(!Array.isArray(x.condition.anchors)||x.condition.anchors.length===0)) d.push({path:`${q}.condition.anchors`,message:"automatic condition requires a typed anchor"});
        }
      }
      if(x.constraints!==undefined&&(!Array.isArray(x.constraints)||x.constraints.some(c=>typeof c!=="string"||c===""))) d.push({path:`${q}.constraints`,message:"constraints must be nonempty strings"});
      anchors(x.anchors, `${q}.anchors`); evidence(x.evidence, `${q}.evidence`, id);
      if(x.type==="grant"&&(!Array.isArray(x.anchors)||x.anchors.length===0)) d.push({path:`${q}.anchors`,message:"grant requires structured scope anchors"});
    }
    for (const [field, items] of [["hazards",a.hazards],["provenance",a.provenance],["declarations",a.declarations],["responses",a.responses],["priorities",a.priorities]] as const) {
      if (!Array.isArray(items)) continue;
      for (let j = 0; j < items.length; j++) {
        const x = items[j]; const q = `${p}.${field}[${j}]`;
        if (!object(x)) { d.push({ path: q, message: `${field} record must be object` }); continue; }
        if(field!=="responses"&&field!=="priorities") recordId(x,q);
        evidence(x.evidence, `${q}.evidence`, id);
        if (field === "responses" && (!Number.isInteger(x.respondsToMessageId) || !oneOf(x.disposition, RESPONSES))) d.push({ path: q, message: "invalid response" });
        if (field === "priorities" && (typeof x.recipient !== "string" || !oneOf(x.value, PRIORITIES))) d.push({ path: q, message: "invalid priority" });
        if (field === "provenance" && (!oneOf(x.kind, ["reported_third_party","inferred_signal"]) || typeof x.summary !== "string" || x.summary === "")) d.push({ path: q, message: "invalid provenance record" });
        if (field === "declarations" && (typeof x.declared !== "string" || typeof x.conflict !== "boolean" || (x.appliesToActId !== undefined && !recordIds.has(x.appliesToActId as string)))) d.push({ path: q, message: "invalid declaration or act reference" });
        if(field==="hazards"&&(typeof x.subject!=="string"||x.subject==="")) d.push({path:q,message:"hazard requires a subject"});
      }
    }
    if(Array.isArray(a.priorities)){
      const recipients=a.priorities.filter(object).map(x=>x.recipient).filter(x=>typeof x==="string");
      if(new Set(recipients).size!==recipients.length)d.push({path:`${p}.priorities`,message:"recipient priority must be unique"});
      if(recipients.length!==1)d.push({path:`${p}.priorities`,message:"directed message requires exactly one recipient priority"});
      else if(source.to!==undefined&&recipients[0]!==source.to)d.push({path:`${p}.priorities[0].recipient`,message:"priority recipient must match the directed source recipient"});
    }
    if(Array.isArray(a.sourceCaveats)&&a.sourceCaveats.some(x=>typeof x!=="string"||x===""))d.push({path:`${p}.sourceCaveats`,message:"source caveats must be nonempty strings"});
    const outcomeActs=new Set<string>();
    for(let j=0;j<(Array.isArray(a.actOutcomes)?a.actOutcomes.length:0);j++){
      const x=a.actOutcomes[j]; const q=`${p}.actOutcomes[${j}]`;
      if(!object(x)||typeof x.actId!=="string"||!recordIds.has(x.actId)||!oneOf(x.value,["fulfilled","violated","unresolved","unassessable"])) { d.push({path:q,message:"invalid act outcome or act reference"}); continue; }
      if(outcomeActs.has(x.actId)) d.push({path:`${q}.actId`,message:"an act may have only one outcome"});
      outcomeActs.add(x.actId); evidence(x.evidence,`${q}.evidence`,id,false);
      if(object(x.evidence)&&Array.isArray(x.evidence.spans))for(const s of x.evidence.spans)if(object(s)&&Number.isInteger(s.messageId)){
        if((x.value==="fulfilled"||x.value==="violated")&&(s.messageId as number)<=id)d.push({path:`${q}.evidence`,message:"fulfilled/violated outcome requires later corpus evidence"});
        if((x.value==="unresolved"||x.value==="unassessable")&&(s.messageId as number)!==id)d.push({path:`${q}.evidence`,message:"unresolved/unassessable outcome must cite its own act"});
      }
      if((x.value==="unresolved"||x.value==="unassessable")&&(!object(x.evidence)||typeof x.evidence.ambiguity!=="string"||x.evidence.ambiguity==="")) d.push({path:`${q}.evidence.ambiguity`,message:"unresolved/unassessable outcome must explain the missing observation"});
    }
    if(Array.isArray(a.acts))for(const x of a.acts)if(object(x)&&["question","request","promise","handoff"].includes(x.type as string)&&typeof x.id==="string"&&!outcomeActs.has(x.id)) d.push({path:`${p}.actOutcomes`,message:`resolution-bearing act ${x.id} requires exactly one outcome`});
  }
  for (const id of expected) if (!seen.has(id)) d.push({ path: "$", message: `missing id ${id}` });
  return d;
}

export function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }

/** Mulberry32 plus Fisher-Yates: small, specified, reproducible across runtimes. */
export function seededSample(population: readonly number[], count: number, seed: number): number[] {
  if (!Number.isInteger(count) || count < 0 || count > population.length) throw new RangeError("invalid sample size");
  let state = seed >>> 0;
  const random = (): number => { state += 0x6d2b79f5; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...population];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out.slice(0, count);
}

export function spanOverlap(a: Evidence, b: Evidence): number {
  let total = 0;
  for (const x of a.spans) for (const y of b.spans) total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return total;
}

/** Maximum-weight one-to-one alignment, deliberately independent of act type. */
export function alignActs(left: readonly Act[], right: readonly Act[]): Array<[number, number]> {
  if (right.length > 20) throw new RangeError("at most 20 right-side acts supported");
  const memo = new Map<string, { score: number; pairs: Array<[number,number]> }>();
  const go = (i: number, mask: number): { score: number; pairs: Array<[number,number]> } => {
    if (i === left.length) return { score: 0, pairs: [] };
    const key = `${i}:${mask}`; const cached = memo.get(key); if (cached) return cached;
    let best = go(i + 1, mask);
    for (let j = 0; j < right.length; j++) if ((mask & (1 << j)) === 0) {
      const overlap = spanOverlap(left[i]!.evidence, right[j]!.evidence); if (overlap === 0) continue;
      const tail = go(i + 1, mask | (1 << j)); const candidate = { score: overlap + tail.score, pairs: [[i,j] as [number,number], ...tail.pairs] };
      if (candidate.score > best.score || (candidate.score === best.score && candidate.pairs.length > best.pairs.length)) best = candidate;
    }
    memo.set(key, best); return best;
  };
  return go(0, 0).pairs;
}

export interface CategoricalAgreement {
  applicable: number;
  support: Record<string, number>;
  confusion: Record<string, Record<string, number>>;
  rawAgreement: number | null;
  kappa: number | null;
  kappaUndefinedReason?: string;
}

/** Scores paired single-valued labels; null means not applicable on that side. */
export function categoricalAgreement(
  pairs: readonly (readonly [string | null, string | null])[],
): CategoricalAgreement {
  const applicable = pairs.filter((p): p is readonly [string,string] => p[0] !== null && p[1] !== null);
  const support: Record<string,number> = {}; const confusion: Record<string,Record<string,number>> = {};
  let agree = 0;
  for (const [a,b] of applicable) {
    support[a] = (support[a] ?? 0) + 1;
    (confusion[a] ??= {})[b] = ((confusion[a] ?? {})[b] ?? 0) + 1;
    if (a === b) agree++;
  }
  const n = applicable.length;
  if (n === 0) return { applicable: 0, support, confusion, rawAgreement: null, kappa: null, kappaUndefinedReason: "no applicable pairs" };
  const labels = new Set(applicable.flatMap(([a,b]) => [a,b]));
  let expected = 0;
  for (const label of labels) {
    const left = applicable.filter(([a]) => a === label).length;
    const right = applicable.filter(([,b]) => b === label).length;
    expected += (left / n) * (right / n);
  }
  const observed = agree / n;
  if (expected === 1) return { applicable:n, support, confusion, rawAgreement:observed, kappa:null, kappaUndefinedReason:"both reviewers have no variance" };
  return { applicable:n, support, confusion, rawAgreement:observed, kappa:(observed-expected)/(1-expected) };
}

export interface PRF { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }
const prf = (tp:number, fp:number, fn:number):PRF => {
  const precision = tp + fp === 0 ? (tp + fn === 0 ? 1 : 0) : tp/(tp+fp);
  const recall = tp + fn === 0 ? (tp + fp === 0 ? 1 : 0) : tp/(tp+fn);
  return { tp,fp,fn,precision,recall,f1:precision+recall===0?0:2*precision*recall/(precision+recall) };
};

/** Primary is reference only for directional names; raw labels remain unadjudicated. */
export function actAgreement(primary: readonly Act[], reviewer: readonly Act[]): {
  boundary: PRF; type: PRF; aligned: Array<[number,number]>;
} {
  const aligned = alignActs(primary, reviewer);
  const sameType = aligned.filter(([a,b]) => primary[a]!.type === reviewer[b]!.type).length;
  return {
    boundary: prf(aligned.length, reviewer.length-aligned.length,primary.length-aligned.length),
    type: prf(sameType,reviewer.length-sameType,primary.length-sameType),
    aligned,
  };
}

export interface GateDimension { name:string; applicable:number; rawAgreement:number|null; kappa:number|null; structural?:boolean; directionalDisagreements?:number }
export interface GateResult { passed:boolean; failures:string[]; provisional:string[]; deferred:string[] }
export function evaluateGate(input:{ dimensions:readonly GateDimension[]; actTypeF1:number; regressionPassed:boolean; deferredDimensions?:readonly string[] }):GateResult {
  const failures:string[]=[]; const provisional:string[]=[]; const deferred:string[]=[]; const deferrals=new Set(input.deferredDimensions??[]);
  for(const x of input.dimensions){
    if(deferrals.has(x.name)){deferred.push(x.name);continue;}
    if(x.applicable<5){ provisional.push(x.name); continue; }
    if(x.rawAgreement===null || x.rawAgreement<0.8) failures.push(`${x.name}: raw agreement below 0.80`);
    if(x.kappa!==null && x.kappa<0.6) failures.push(`${x.name}: kappa below 0.60`);
    if(x.structural && (x.directionalDisagreements??0)>=3) failures.push(`${x.name}: repeated directional disagreement`);
  }
  if(input.actTypeF1<0.8) failures.push("acts: type F1 below 0.80");
  if(!input.regressionPassed) failures.push("original-15 regression failed");
  return {passed:failures.length===0,failures,provisional,deferred};
}
