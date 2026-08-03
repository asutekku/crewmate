import { describe,expect,test } from "bun:test";
import { FEATURE_IDS, FEATURES, featureForAct, featureForCandidate, featureForVerb, helpFeatures } from "../core/features.ts";
import { VERBS } from "../core/verbs.ts";

describe("one canonical feature registry",()=>{
  test("ids are unique, labels nonempty, and every mapped help verb exists",()=>{expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);for(const f of FEATURES){expect(f.label.trim()).not.toBe("");for(const verb of f.helpVerbs)expect(VERBS.some(v=>v.verb===verb||(v.aliases??[]).includes(verb))).toBe(true);}});
  test("every advertised CLI operation except help has one feature owner",()=>{for(const v of VERBS.filter(x=>!x.hidden&&x.verb!=="help")){expect(featureForVerb(v.verb),v.verb).toBeDefined();for(const alias of v.aliases??[])expect(featureForVerb(alias),alias).toBeDefined();}});
  test("help exposure is exactly the features owning rendered verbs",()=>{expect(helpFeatures()).toEqual(FEATURES.filter(f=>f.helpVerbs.length>0).map(f=>f.id));expect(helpFeatures()).not.toContain("tasks");expect(helpFeatures()).not.toContain("injection-suppression");});
  test("candidate and act mappings use canonical ids",()=>{expect(featureForCandidate("obligation:o1")).toBe("obligations");expect(featureForCandidate("unknown:x")).toBeUndefined();expect(featureForAct("correction")).toBe("corrections");expect(featureForAct("grant")).toBe("clearances");});
  test("the install manifest is generated from this registry",async()=>{const source=await Bun.file(new URL("../install.ts",import.meta.url)).text();expect(source).toContain("const FEATURE_SET = FEATURE_IDS");expect(source).not.toContain('"injection-inbox",\n] as const');});
});
