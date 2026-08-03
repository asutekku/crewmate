import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../cli.ts", import.meta.url)).text();

function caseBody(name:string):string {
  const start=source.indexOf(`case "${name}"`);
  if(start<0)return "";
  const next=source.indexOf("\n  case ",start+8);
  return source.slice(start,next<0?source.length:next);
}

describe("P2 CLI contract",()=>{
  test.each(["request","promise","handoff","grant","correct","hazard"])("%s dispatches through the one structured batch service",verb=>{
    expect(caseBody(verb)).toContain("structured(");
  });
  test("ask uses the same structured service and creates a question act",()=>{
    const start=source.indexOf("function ask(");
    const end=source.indexOf("\n}",start);
    const body=source.slice(start,end);
    expect(body).toContain("structured(");
    expect(body).toContain('type:"question"');
  });
  test("compound act forwards typed acts, dependencies and idempotency key",()=>{
    const body=caseBody("act");
    expect(body).toContain("body.acts");
    expect(body).toContain("body.dependencies");
    expect(body).toContain("body.idempotencyKey");
  });
  test.each(["msg","say"])("plain %s never calls the semantic service",verb=>{
    expect(caseBody(verb)).not.toContain("structured(");
    expect(caseBody(verb)).not.toContain("obligations");
  });
  test("obligation and clearance lifecycle commands are both dispatched",()=>{
    expect(caseBody("obligation")).toContain("obligationCommand");
    expect(caseBody("clearance")).toContain("clearanceCommand");
  });
});
