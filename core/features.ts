/** Canonical P3 feature identity and surface mappings. */
export const FEATURES = [
  {id:"roster",label:"roster",helpVerbs:["who","where","quit","export"]},
  {id:"messages",label:"messages",helpVerbs:["log","say","msg","clear"]},
  {id:"work",label:"work items",helpVerbs:["doing","did","undo","step","add","done","board","link","plans","mine","breaks","needs"]},
  {id:"diary",label:"diary findings",helpVerbs:["note","recall","topics","topic","tags","bugs","note-deprecate","note-supersede","diary"]},
  {id:"questions",label:"questions",helpVerbs:["asks","answer"]},
  {id:"memories",label:"personal memories",helpVerbs:["remember","about-me","forget","memories"]},
  {id:"lineage",label:"lineage",helpVerbs:["inherit"]},
  {id:"stats",label:"stats",helpVerbs:["stats"]},
  {id:"injection",label:"injection",helpVerbs:["injection"]},
  {id:"injection-suppression",label:"injection suppression",helpVerbs:[]},
  {id:"injection-inbox",label:"injection inbox",helpVerbs:["inbox"]},
  {id:"obligations",label:"obligations",helpVerbs:["ask","request","promise","handoff","act","obligation","obligations","clearances"]},
  {id:"clearances",label:"clearances",helpVerbs:["grant","clearance"]},
  {id:"hazards",label:"hazards",helpVerbs:["hazard"]},
  {id:"corrections",label:"corrections",helpVerbs:["correct"]},
  {id:"claims",label:"claims",helpVerbs:["files","blame"]},
  {id:"aliases",label:"aliases",helpVerbs:["call-me","set-role","call-you","name","role"]},
  {id:"release",label:"name release",helpVerbs:["release"]},
  {id:"minions",label:"minions",helpVerbs:[]},
  {id:"tasks",label:"tasks",helpVerbs:[]},
] as const;

export type FeatureId = typeof FEATURES[number]["id"];
export const FEATURE_IDS = FEATURES.map((feature) => feature.id) as FeatureId[];
const idSet = new Set<string>(FEATURE_IDS);

export const isFeatureId = (value: string): value is FeatureId => idSet.has(value);
export const featureLabel = (id: FeatureId): string =>
  FEATURES.find((feature) => feature.id === id)!.label;
export const helpFeatures = (): FeatureId[] =>
  FEATURES.filter((feature) => feature.helpVerbs.length > 0).map((feature) => feature.id);

export function featureForVerb(verb: string): FeatureId | undefined {
  return FEATURES.find((feature) =>
    (feature.helpVerbs as readonly string[]).includes(verb),
  )?.id;
}

export function featureForCandidate(key: string): FeatureId | undefined {
  if (key.startsWith("obligation:")) return "obligations";
  if (key.startsWith("diary")) return "diary";
  if (key.startsWith("work")) return "work";
  if (key.startsWith("memor")) return "memories";
  if (key === "recent") return "messages";
  if (key === "roster") return "roster";
  return undefined;
}
export function featureForAct(type: string): FeatureId {
  if (type === "grant") return "clearances";
  if (type === "hazard") return "hazards";
  if (type === "correction") return "corrections";
  return "obligations";
}
