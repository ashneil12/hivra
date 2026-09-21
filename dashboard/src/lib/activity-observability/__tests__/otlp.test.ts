import { normalizeOtlpJson } from "../otlp";

const NOW=new Date("2026-09-21T20:00:00.000Z");
const ns="1790020800000000000";
const attr=(key:string,stringValue:string)=>({key,value:{stringValue}});

describe("OTLP JSON normalization",()=>{
  it("accepts trace and log OTLP JSON while retaining only safe structured fields",()=>{
    const result=normalizeOtlpJson({
      resourceSpans:[{resource:{attributes:[attr("service.name","codex"),attr("service.namespace","sk-test-secret")]},scopeSpans:[{spans:[{traceId:"a".repeat(32),spanId:"b".repeat(16),name:"curl -H Authorization: Bearer secret",startTimeUnixNano:ns,status:{code:1},attributes:[attr("gen_ai.operation.name","tool.call"),attr("command","rm-secret")]}]}]}],
      resourceLogs:[{resource:{attributes:[attr("service.name","claude-code")]},scopeLogs:[{logRecords:[{timeUnixNano:ns,traceId:"c".repeat(32),spanId:"d".repeat(16),eventName:"secret event body",body:{stringValue:"private prompt"},attributes:[attr("tool_name","Read"),attr("success","true"),attr("session.id","session-1"),attr("tool.input","private-command")]}]}]}],
    },"00000000-0000-4000-8000-000000000001",NOW)!;
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({title:"tool.call operation",sourceKind:"otlp_trace"});
    expect(result.events[1]).toMatchObject({title:"Read used",sourceKind:"otlp_log",outcome:"success"});
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("deduplicates exact records but preserves distinct nanosecond log events",()=>{
    const body=(time:string)=>({resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:time,attributes:[attr("tool","shell")]}]}]}]});
    const a=normalizeOtlpJson(body("1790020800000000001"),"00000000-0000-4000-8000-000000000001",NOW)!.events[0];
    const same=normalizeOtlpJson(body("1790020800000000001"),"00000000-0000-4000-8000-000000000001",NOW)!.events[0];
    const next=normalizeOtlpJson(body("1790020800000000002"),"00000000-0000-4000-8000-000000000001",NOW)!.events[0];
    expect(a.id).toBe(same.id); expect(next.id).not.toBe(a.id);
  });

  it("reports malformed and future records as rejected",()=>{
    const result=normalizeOtlpJson({resourceSpans:[{scopeSpans:[{spans:[{traceId:"bad",spanId:"bad",startTimeUnixNano:ns}]}]}],resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:"9999999999999999999"}]}]}]},"00000000-0000-4000-8000-000000000001",NOW)!;
    expect(result).toMatchObject({events:[],rejectedSpans:1,rejectedLogRecords:1});
  });
});
