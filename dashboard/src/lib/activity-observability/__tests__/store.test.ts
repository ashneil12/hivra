import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOtlpJson } from "../otlp";
import { persistTelemetryEvents } from "../store";

const A="00000000-0000-4000-8000-000000000001";
const attr=(key:string,stringValue:string)=>({key,value:{stringValue}});

describe("telemetry persistence",()=>{
  it("stores the validated native run fields in detail.telemetry",async()=>{
    const body={resourceLogs:[{resource:{attributes:[attr("service.namespace","hivra.native")]},scopeLogs:[{logRecords:[{timeUnixNano:"1790020800000000000",traceId:"c".repeat(32),spanId:"d".repeat(16),attributes:[
      attr("event.name","tool.failed"),attr("service.name","claude-code"),attr("event.id","0123456789abcdef0123456789abcdef"),attr("session.id","prompt-1"),attr("conversation.id","session-1"),
      attr("tool.name","Read"),{key:"duration_ms",value:{intValue:"42"}},attr("error.type","not_found"),attr("parent.span.id","0123456789abcdef"),
    ]}]}]}]};
    const events=normalizeOtlpJson(body,A,new Date("2026-09-21T20:00:00Z"))!.events;
    let rows:Array<{detail:{telemetry:Record<string,unknown>}}>=[];
    const select=jest.fn(async()=>({data:rows.map(()=>({id:"x"})),error:null}));
    const client={from:jest.fn(()=>({upsert:jest.fn((value:typeof rows)=>{rows=value;return{select};})}))} as unknown as SupabaseClient;
    await expect(persistTelemetryEvents(client,"user_1",{id:A,type:"claude-code",name:"Box"},events)).resolves.toMatchObject({accepted:1});
    expect(rows[0].detail.telemetry).toMatchObject({role:"tool.failed",producer:"claude-code",toolName:"Read",durationMs:42,conversationId:"session-1",parentSpanId:"0123456789abcdef",errorType:"not_found",runId:"prompt-1",outcome:"failure",severity:"warning"});
  });
});
