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

function token(resourceIds=[A]){const now=Math.floor(Date.now()/1000);return mintActivityCollectorToken({userId:"user_1",resourceIds,iat:now-1,exp:now+300},SECRET);}
function request(body:unknown,resourceId=A,bearer=token(),headers:Record<string,string>={}){return new Request("http://localhost/api/activity/ingest",{method:"POST",headers:{authorization:`Bearer ${bearer}`,"x-hivra-resource-id":resourceId,"content-type":"application/json",...headers},body:JSON.stringify(body)}) as unknown as NextRequest;}
type InsertedRow=Record<string,unknown>&{id:string};
function database(agent:unknown={id:A,user_id:"user_1",type:"codex",name:"Fixture",status:"running"},inserted:{rows?:InsertedRow[]}={}){
  const agentQuery={select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),neq:jest.fn().mockReturnThis(),maybeSingle:jest.fn().mockResolvedValue({data:agent,error:null})};
  const select=jest.fn().mockImplementation(async()=>({data:(inserted.rows??[]).map((r)=>({id:r.id})),error:null}));
  const upsert=jest.fn().mockImplementation((rows:InsertedRow[])=>{inserted.rows=rows;return{select}});
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table:string)=>table==="hivra_agents"?agentQuery:table==="hivra_agent_events"?{upsert}:(()=>{throw new Error(table)})());
  return {inserted,upsert,select};
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
    database(null); const response=await POST(request(payload(),B,token([A,B]))); expect(response.status).toBe(404);
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
  });
  it("returns the OTLP partialSuccess schema for rejected records",async()=>{
    database(); const response=await POST(request({resourceSpans:[{scopeSpans:[{spans:[{traceId:"bad",spanId:"bad",startTimeUnixNano:ns()}]}]}]}));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({partialSuccess:{rejectedSpans:1,errorMessage:expect.any(String)}});
  });
});
