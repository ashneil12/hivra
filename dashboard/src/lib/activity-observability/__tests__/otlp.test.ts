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

const RESOURCE="00000000-0000-4000-8000-000000000001";
const EVENT_ID="0123456789abcdef0123456789abcdef";
type Attr={key:string;value:Record<string,unknown>};
const int=(key:string,intValue:number|string)=>({key,value:{intValue:String(intValue)}});
const bool=(key:string,boolValue:boolean)=>({key,value:{boolValue}});
/** One native record as the guest reporter sends it. */
function native(role:string,attrs:Attr[]=[],over:{service?:string;eventId?:string|null;runId?:string|null;time?:string;resource?:Attr[]}={}){
  const base:Attr[]=[attr("event.name",role),attr("service.name",over.service??"codex"),attr("conversation.id","thread-1")];
  if(over.eventId!==null) base.push(attr("event.id",over.eventId??EVENT_ID));
  if(over.runId!==null) base.push(attr("session.id",over.runId??"turn-1"));
  return {resourceLogs:[{resource:{attributes:over.resource??[attr("service.namespace","hivra.native")]},scopeLogs:[{logRecords:[{timeUnixNano:over.time??ns,severityNumber:9,traceId:"c".repeat(32),spanId:"d".repeat(16),attributes:[...base,...attrs]}]}]}]};
}
const one=(body:unknown)=>normalizeOtlpJson(body,RESOURCE,NOW)!;

describe("native agent-run records",()=>{
  it.each([
    ["run.started",[],{title:"Codex started a task",outcome:"unknown",severity:"info"}],
    ["run.completed",[int("duration_ms",5000)],{title:"Codex finished a task in 5.0 s",outcome:"success",severity:"info"}],
    ["run.failed",[attr("error.type","rate_limit")],{title:"Codex task ended with a failure",outcome:"failure",severity:"error",errorType:"rate_limit"}],
    ["run.stopped",[],{title:"Codex task was stopped",outcome:"unknown",severity:"info"}],
    ["tool.started",[attr("tool.name","exec_command")],{title:"Tool exec_command started",outcome:"unknown",severity:"info",toolName:"exec_command"}],
    ["tool.completed",[attr("tool.name","Read"),int("duration_ms",850),bool("success",true)],{title:"Tool Read finished in 850 ms",outcome:"success",severity:"info",durationMs:850}],
    ["tool.completed",[attr("tool.name","exec_command"),int("duration_ms",65_000)],{title:"Tool exec_command finished in 1 min 5 s",outcome:"unknown",summary:"The agent did not report whether it succeeded."}],
    ["tool.failed",[attr("tool.name","Read"),int("duration_ms",1200)],{title:"Tool Read failed after 1.2 s",outcome:"failure",severity:"warning"}],
  ] as Array<[string,Attr[],Record<string,unknown>]>)("maps %s to plain-English text, outcome and severity",(role,attrs,expected)=>{
    const result=one(native(role,attrs));
    expect(result.heartbeats).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({role,producer:"codex",runId:"turn-1",conversationId:"thread-1",sourceKind:"otlp_log",event:"otel_log",...expected});
  });

  it("uses the role, not severityNumber, for severity and names Claude Code",()=>{
    const body=native("tool.failed",[attr("tool.name","Read")],{service:"claude-code"});
    (body.resourceLogs[0].scopeLogs[0].logRecords[0] as Record<string,unknown>).severityNumber=17;
    expect(one(body).events[0]).toMatchObject({severity:"warning",producer:"claude-code",evidence:expect.arrayContaining([{label:"Agent",value:"Claude Code"}])});
    expect(one(native("run.started",[],{service:"claude-code"})).events[0].title).toBe("Claude Code started a task");
  });

  it("returns heartbeats separately and never as events",()=>{
    const result=one(native("collector.heartbeat",[],{service:"hivra-agent-trace",runId:null}));
    expect(result).toMatchObject({events:[],heartbeats:[{occurredAt:"2026-09-21T20:00:00.000Z"}],rejectedLogRecords:0});
    expect(one(native("collector.heartbeat",[],{service:"codex"}))).toMatchObject({events:[],heartbeats:[],rejectedLogRecords:1});
  });

  it("rejects and counts unknown roles, producers, ids and runs",()=>{
    for(const body of [native("run.exfiltrated"),native("tool.started",[],{service:"aider"}),native("run.started",[],{eventId:null}),native("run.started",[],{eventId:"0123456789ABCDEF0123456789ABCDEF"}),native("run.started",[],{eventId:"short"}),native("run.started",[],{runId:null}),native("run.started",[],{runId:"turn 1; rm"})]) {
      expect(one(body)).toMatchObject({events:[],heartbeats:[],rejectedLogRecords:1});
    }
  });

  it("keeps MCP tool names, drops unsafe ones, and falls back to 'A tool'",()=>{
    expect(one(native("tool.started",[attr("tool.name","mcp__github__create_issue")])).events[0]).toMatchObject({toolName:"mcp__github__create_issue",title:"Tool mcp__github__create_issue started"});
    for(const name of ["Bash; rm","web search","a/b","-rf",`x${"y".repeat(120)}`]) {
      const event=one(native("tool.started",[attr("tool.name",name)])).events[0];
      expect(event.toolName).toBeUndefined(); expect(event.title).toBe("A tool started");
      expect(JSON.stringify(event)).not.toContain(name);
    }
  });

  it("accepts only lower-case 16-hex parent span ids and keeps them out of stored attributes",()=>{
    const good=one(native("tool.started",[attr("parent.span.id","0123456789abcdef")])).events[0];
    expect(good.parentSpanId).toBe("0123456789abcdef");
    expect(Object.keys(good.safeAttributes)).not.toContain("parent.span.id");
    for(const bad of ["0123456789ABCDEF","0123456789abcde","not-a-span-id!!!","0123456789abcdef0"]) expect(one(native("tool.started",[attr("parent.span.id",bad)])).events[0].parentSpanId).toBeUndefined();
  });

  it("bounds durations and error types",()=>{
    expect(one(native("tool.completed",[int("duration_ms",604_800_000)])).events[0].durationMs).toBe(604_800_000);
    for(const bad of [int("duration_ms",604_800_001),int("duration_ms",-1),{key:"duration_ms",value:{doubleValue:12.5}},attr("duration_ms","12")]) expect(one(native("tool.completed",[bad])).events[0].durationMs).toBeUndefined();
    expect(one(native("run.failed",[attr("error.type","Rate limit exceeded: retry")])).events[0].errorType).toBeUndefined();
    expect(one(native("run.completed",[attr("error.type","rate_limit")])).events[0].errorType).toBeUndefined();
  });

  it("drops secret-like values and never stores content fields",()=>{
    const result=one(native("tool.completed",[attr("tool.name","sk-live-abc"),attr("tool.input","private-command"),attr("command","rm -rf"),{key:"prompt",value:{stringValue:"private prompt"}}],{runId:"turn-1"}));
    const event=result.events[0];
    expect(event.toolName).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/sk-live|private|rm -rf/);
    expect(one(native("run.started",[attr("conversation.id","ghp_abcdef")])).events[0].conversationId).toBeUndefined();
    expect(one(native("run.started",[],{runId:"ghp_abcdef"}))).toMatchObject({events:[],rejectedLogRecords:1});
    expect(Object.keys(event.safeAttributes).sort()).toEqual(["conversation.id","event.id","event.name","service.name","service.namespace","session.id"]);
  });

  it("derives a stable id from the reporter's event id so replays dedupe",()=>{
    const first=one(native("tool.started",[attr("tool.name","Read")])).events[0];
    const replay=one(native("tool.started",[attr("tool.name","Read")],{time:"1790020805000000000"})).events[0];
    const other=one(native("tool.started",[attr("tool.name","Read")],{eventId:"f".repeat(32)})).events[0];
    const elsewhere=normalizeOtlpJson(native("tool.started",[attr("tool.name","Read")]),"00000000-0000-4000-8000-000000000002",NOW)!.events[0];
    expect(replay.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(elsewhere.id).not.toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("leaves records without the native namespace on the generic path",()=>{
    const result=one(native("run.started",[attr("tool_name","Read")],{resource:[attr("service.name","codex")]}));
    expect(result.events[0]).toMatchObject({title:"Read used"}); expect(result.events[0].role).toBeUndefined();
  });
});
