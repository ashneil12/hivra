import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { mintActivityCollectorToken } from "@/lib/activity-observability/auth";
import { buildActivitySnapshot, type ActivityEventRow } from "@/lib/activity-observability/feed";
import { supabaseAdmin } from "@/lib/supabase";
import { POST } from "../route";

jest.mock("@/lib/supabase",()=>({supabaseAdmin:{from:jest.fn()}}));
const A="00000000-0000-4000-8000-000000000001",B="00000000-0000-4000-8000-000000000002";
const SECRET=randomBytes(32).toString("hex"); const ORIGINAL_ENV=process.env;
const ns=()=>String(BigInt(Date.now())*1_000_000n);
const attr=(key:string,stringValue:string)=>({key,value:{stringValue}});
const payload=()=>({resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:ns(),traceId:"a".repeat(32),spanId:"b".repeat(16),eventName:"private prompt",body:{stringValue:"raw-secret"},attributes:[attr("tool_name","Read"),attr("success","true"),attr("command","raw-secret")]}]}]}]});
const NATIVE=[attr("service.namespace","hivra.native")];
const heartbeat=()=>({resourceLogs:[{resource:{attributes:NATIVE},scopeLogs:[{logRecords:[{timeUnixNano:String(BigInt(Date.now()-240_000)*1_000_000n),attributes:[attr("event.name","collector.heartbeat"),attr("service.name","hivra-agent-trace"),attr("event.id","e".repeat(32))]}]}]}]});
const nativeRecord=(role:string,extra:Array<{key:string;value:Record<string,unknown>}>=[],eventId="0123456789abcdef0123456789abcdef")=>({timeUnixNano:ns(),traceId:"c".repeat(32),spanId:"d".repeat(16),attributes:[attr("event.name",role),attr("service.name","codex"),attr("event.id",eventId),attr("session.id","turn-1"),attr("conversation.id","thread-1"),...extra]});
const nativeBody=(...records:unknown[])=>({resourceLogs:[{resource:{attributes:NATIVE},scopeLogs:[{logRecords:records}]}]});

function token(resourceIds=[A],lifetime={iat:-1,exp:300}){const now=Math.floor(Date.now()/1000);return mintActivityCollectorToken({userId:"user_1",resourceIds,iat:now+lifetime.iat,exp:now+lifetime.exp},SECRET);}
function request(body:unknown,resourceId=A,bearer=token(),headers:Record<string,string>={}){return new Request("http://localhost/api/activity/ingest",{method:"POST",headers:{authorization:`Bearer ${bearer}`,"x-hivra-resource-id":resourceId,"content-type":"application/json",...headers},body:JSON.stringify(body)}) as unknown as NextRequest;}
type InsertedRow=Record<string,unknown>&{id:string};
const OWNED={id:A,user_id:"user_1",type:"codex",name:"Fixture",status:"running",desired_state:"running"};
function database(agent:unknown=OWNED,inserted:{rows?:InsertedRow[]}={}){
  const agentQuery={select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),neq:jest.fn().mockReturnThis(),maybeSingle:jest.fn().mockResolvedValue({data:agent,error:null})};
  const select=jest.fn().mockImplementation(async()=>({data:(inserted.rows??[]).map((r)=>({id:r.id})),error:null}));
  const upsert=jest.fn().mockImplementation((rows:InsertedRow[])=>{inserted.rows=rows;return{select}});
  const collectorUpsert=jest.fn().mockResolvedValue({error:null});
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table:string)=>table==="hivra_agents"?agentQuery:table==="hivra_agent_events"?{upsert}:table==="hivra_activity_collectors"?{upsert:collectorUpsert}:(()=>{throw new Error(table)})());
  return {inserted,upsert,select,collectorUpsert,agentQuery};
}

describe("POST /api/activity/ingest",()=>{
  beforeEach(()=>{process.env={...ORIGINAL_ENV,ACTIVITY_COLLECTOR_SIGNING_SECRET:SECRET};jest.clearAllMocks();});
  afterAll(()=>{process.env=ORIGINAL_ENV;});
  it("rejects missing auth and resources outside the signed allowlist",async()=>{
    expect((await POST(request(payload(),A,"bad"))).status).toBe(401);
    expect((await POST(request(payload(),B,token([A])))).status).toBe(403);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });
  it("does not disclose or accept a foreign owned resource",async()=>{
    const db=database(null); const response=await POST(request(payload(),B,token([A,B]))); expect(response.status).toBe(404);
    expect(db.agentQuery.eq).toHaveBeenCalledWith("user_id","user_1"); expect(db.collectorUpsert).not.toHaveBeenCalled();
  });
  it("refuses a deleted computer and one whose deletion is pending",async()=>{
    for(const agent of [{...OWNED,status:"deleted"},{...OWNED,desired_state:"deleted"}]) {
      const db=database(agent); const response=await POST(request(heartbeat())); expect(response.status).toBe(404);
      expect(db.upsert).not.toHaveBeenCalled(); expect(db.collectorUpsert).not.toHaveBeenCalled();
    }
    const legacy=database({...OWNED,desired_state:null}); expect((await POST(request(heartbeat()))).status).toBe(200); expect(legacy.collectorUpsert).toHaveBeenCalled();
  });
  it("bounds declared and streamed bodies",async()=>{
    expect((await POST(request(payload(),A,token(),{"content-length":"1048577"}))).status).toBe(413);
    const huge={resourceLogs:[],padding:"x".repeat(1_048_576)}; expect((await POST(request(huge))).status).toBe(413);
  });
  it("persists, deduplicates, redacts, and can be read through the feed normalizer",async()=>{
    const state:{rows?:InsertedRow[]}={}; database(undefined,state); const first=await POST(request(payload())); expect(first.status).toBe(200); expect(first.headers.get("x-hivra-accepted")).toBe("1");
    expect(JSON.stringify(state.rows)).not.toContain("raw-secret"); expect(JSON.stringify(state.rows)).not.toContain("private prompt");
    const row=state.rows![0] as unknown as ActivityEventRow; const snapshot=buildActivitySnapshot({limit:10,now:new Date(),sessionRows:[],agentRows:[{id:A,name:"Fixture",type:"codex",status:"running",created_at:new Date().toISOString()}],eventRows:[row]});
    expect(snapshot.events[0]).toMatchObject({kind:"tool_activity",title:"Read used",agentId:A});
    const duplicateState:{rows?:InsertedRow[]}={}; const db=database(undefined,duplicateState); db.select.mockResolvedValueOnce({data:[],error:null}); const second=await POST(request(payload())); expect(second.headers.get("x-hivra-duplicates")).toBe("1");
    expect(db.collectorUpsert).not.toHaveBeenCalled();
  });
  it("returns the OTLP partialSuccess schema for rejected records",async()=>{
    database(); const response=await POST(request({resourceSpans:[{scopeSpans:[{spans:[{traceId:"bad",spanId:"bad",startTimeUnixNano:ns()}]}]}]}));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({partialSuccess:{rejectedSpans:1,errorMessage:expect.any(String)}});
  });

  it("accepts a heartbeat-only request and records server receive time and the token's expiry",async()=>{
    const db=database(); const before=Date.now(); const bearer=token([A],{iat:-10,exp:3600});
    const response=await POST(request(heartbeat(),A,bearer)); const after=Date.now();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({}); expect(response.headers.get("x-hivra-accepted")).toBe("0");
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.collectorUpsert).toHaveBeenCalledTimes(1);
    const [row,options]=db.collectorUpsert.mock.calls[0];
    expect(options).toEqual({onConflict:"agent_id"});
    expect(row).toMatchObject({agent_id:A,user_id:"user_1"});
    // The heartbeat's own timestamp (4 minutes earlier) is ignored; the guest clock is never trusted for liveness.
    expect(Date.parse(row.last_heartbeat_at)).toBeGreaterThanOrEqual(before); expect(Date.parse(row.last_heartbeat_at)).toBeLessThanOrEqual(after);
    const exp=JSON.parse(Buffer.from(bearer.split(".")[1],"base64url").toString("utf8")).exp;
    expect(row.credential_expires_at).toBe(new Date(exp*1000).toISOString());
    expect(row).not.toHaveProperty("last_event_at");
  });

  it("records a heartbeat from a computer whose clock is 6 minutes fast, and says why its run records were refused",async()=>{
    const ahead=String(BigInt(Date.now()+6*60_000)*1_000_000n);
    const body=heartbeat(); body.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano=ahead;
    const db=database(); const before=Date.now();
    const response=await POST(request(body)); expect(response.status).toBe(200); expect(await response.json()).toEqual({});
    const rows=db.collectorUpsert.mock.calls.map(([row])=>row);
    const beat=rows.find(r=>r.last_heartbeat_at); expect(beat).toBeDefined();
    expect(Date.parse(beat.last_heartbeat_at)).toBeGreaterThanOrEqual(before); expect(Date.parse(beat.last_heartbeat_at)).toBeLessThanOrEqual(Date.now());
    // The heartbeat alone shows the clock is ahead of the event window, so run
    // records from this computer will be refused: that is recorded, not hidden.
    expect(rows).toContainEqual(expect.objectContaining({agent_id:A,last_rejected_reason:"clock_skew"}));
    const skewed=database(); const run={...nativeRecord("run.started",[],"5".repeat(32)),timeUnixNano:ahead};
    const refused=await POST(request(nativeBody(run))); expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({partialSuccess:{rejectedLogRecords:1,errorMessage:expect.stringContaining("check the computer's clock")}});
    expect(skewed.collectorUpsert).toHaveBeenCalledWith(expect.objectContaining({agent_id:A,user_id:"user_1",last_rejected_reason:"clock_skew",last_rejected_at:expect.any(String)}),{onConflict:"agent_id"});
    // A correct clock records no skew.
    const fine=database(); expect((await POST(request(heartbeat()))).status).toBe(200);
    expect(fine.collectorUpsert.mock.calls.map(([row])=>row.last_rejected_reason).filter(Boolean)).toEqual([]);
  });

  it("records a correctly signed expired token against the owner's computer, then refuses it",async()=>{
    const db=database(); const expired=token([A],{iat:-7200,exp:-60});
    const response=await POST(request(heartbeat(),A,expired)); expect(response.status).toBe(401);
    expect(db.collectorUpsert).toHaveBeenCalledWith(expect.objectContaining({agent_id:A,user_id:"user_1",last_rejected_reason:"expired",last_rejected_at:expect.any(String)}),{onConflict:"agent_id"});
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("does not record expiry for a forged, foreign or out-of-scope token",async()=>{
    const expired=token([A],{iat:-7200,exp:-60});
    let db=database(); expect((await POST(request(heartbeat(),A,`${expired.slice(0,-1)}${expired.endsWith("x")?"y":"x"}`))).status).toBe(401);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    db=database(); expect((await POST(request(heartbeat(),B,expired))).status).toBe(401); expect(db.collectorUpsert).not.toHaveBeenCalled();
    db=database(null); expect((await POST(request(heartbeat(),A,expired))).status).toBe(401); expect(db.collectorUpsert).not.toHaveBeenCalled();
  });

  it("round-trips native run records into the feed and records the accepted event time",async()=>{
    const state:{rows?:InsertedRow[]}={}; const db=database(undefined,state);
    const body=nativeBody(
      nativeRecord("run.started",[],"1".repeat(32)),
      nativeRecord("tool.failed",[attr("tool.name","Bash; rm -rf"),{key:"duration_ms",value:{intValue:"1500"}},attr("parent.span.id","0123456789abcdef")],"2".repeat(32)),
      nativeRecord("run.failed",[attr("error.type","rate_limit")],"3".repeat(32)),
      nativeRecord("run.exfiltrate",[],"4".repeat(32)),
    );
    const response=await POST(request(body)); expect(response.status).toBe(200);
    expect(response.headers.get("x-hivra-accepted")).toBe("3");
    expect(await response.json()).toEqual({partialSuccess:{rejectedLogRecords:1,errorMessage:expect.any(String)}});
    expect(JSON.stringify(state.rows)).not.toContain("rm -rf");
    expect(db.collectorUpsert).toHaveBeenCalledWith(expect.objectContaining({agent_id:A,last_event_at:expect.any(String),credential_expires_at:expect.any(String)}),{onConflict:"agent_id"});
    const snapshot=buildActivitySnapshot({limit:10,now:new Date(),sessionRows:[],agentRows:[{id:A,name:"Fixture",type:"codex",status:"running",created_at:new Date().toISOString()}],eventRows:state.rows as unknown as ActivityEventRow[]});
    const byRole=Object.fromEntries(snapshot.events.map(e=>[e.role,e]));
    expect(byRole["run.started"]).toMatchObject({title:"Codex started a task",runId:"turn-1",conversationId:"thread-1",needsAttention:false});
    expect(byRole["tool.failed"]).toMatchObject({title:"A tool failed after 1.5 s",severity:"warning",parentSpanId:"0123456789abcdef",needsAttention:false});
    expect(byRole["run.failed"]).toMatchObject({title:"Codex task ended with a failure",errorType:"rate_limit",needsAttention:true});
    const replay:{rows?:InsertedRow[]}={}; database(undefined,replay); await POST(request(body));
    expect(replay.rows!.map(r=>r.id)).toEqual(state.rows!.map(r=>r.id));
  });
});
