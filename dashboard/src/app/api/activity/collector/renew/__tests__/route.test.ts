import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { inspectActivityCollectorToken, mintActivityCollectorToken } from "@/lib/activity-observability/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { POST } from "../route";

jest.mock("@/lib/supabase",()=>({supabaseAdmin:{from:jest.fn()}}));
const A="00000000-0000-4000-8000-000000000001",B="00000000-0000-4000-8000-000000000002";
const SECRET=randomBytes(32).toString("hex"); const ORIGINAL_ENV=process.env;
const HOUR=3600, DAY=86_400;

function token(resourceIds=[A],lifetime={iat:-4*DAY,exp:3*DAY},userId="user_1"){const now=Math.floor(Date.now()/1000);return mintActivityCollectorToken({userId,resourceIds,iat:now+lifetime.iat,exp:now+lifetime.exp},SECRET);}
function request(bearer=token(),resourceId=A,body:string|null="{}"){return new Request("http://localhost/api/activity/collector/renew",{method:"POST",headers:{authorization:`Bearer ${bearer}`,"x-hivra-resource-id":resourceId,"content-type":"application/json"},...(body===null?{}:{body})}) as unknown as NextRequest;}
const OWNED={id:A,user_id:"user_1",type:"claude-code",status:"running",desired_state:"running",computer_substrate:"proxmox-kvm"};
function database(agent:unknown=OWNED){
  const agentQuery={select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),neq:jest.fn().mockReturnThis(),maybeSingle:jest.fn().mockResolvedValue({data:agent,error:null})};
  const collectorUpsert=jest.fn().mockResolvedValue({error:null});
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table:string)=>table==="hivra_agents"?agentQuery:table==="hivra_activity_collectors"?{upsert:collectorUpsert}:(()=>{throw new Error(table)})());
  return {agentQuery,collectorUpsert};
}

describe("POST /api/activity/collector/renew",()=>{
  let logs:jest.SpyInstance[]=[];
  beforeEach(()=>{process.env={...ORIGINAL_ENV,ACTIVITY_COLLECTOR_SIGNING_SECRET:SECRET};jest.clearAllMocks();logs=(["log","info","warn","error"] as const).map(m=>jest.spyOn(console,m).mockImplementation(()=>undefined));});
  afterEach(()=>{for(const spy of logs) spy.mockRestore();});
  afterAll(()=>{process.env=ORIGINAL_ENV;});

  it("issues a fresh 7-day token for the same computer, uncached, and records the renewal",async()=>{
    const db=database(); const presented=token(); const before=Math.floor(Date.now()/1000);
    const response=await POST(request(presented));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body=await response.json();
    expect(Object.keys(body).sort()).toEqual(["expiresAt","token"]);
    expect(body.token).toMatch(/^hvra_otlp_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.token).not.toBe(presented);
    const inspected=inspectActivityCollectorToken(`Bearer ${body.token}`);
    expect(inspected).toMatchObject({status:"valid",claims:{userId:"user_1",resourceIds:[A]}});
    const claims=(inspected as {claims:{iat:number;exp:number}}).claims;
    expect(claims.iat).toBeGreaterThanOrEqual(before); expect(claims.exp-claims.iat).toBe(7*DAY);
    expect(body.expiresAt).toBe(new Date(claims.exp*1000).toISOString());
    expect(db.agentQuery.eq).toHaveBeenCalledWith("id",A); expect(db.agentQuery.eq).toHaveBeenCalledWith("user_id","user_1");
    expect(db.collectorUpsert).toHaveBeenCalledWith(expect.objectContaining({agent_id:A,user_id:"user_1",issue_reason:"renew",credential_expires_at:body.expiresAt}),{onConflict:"agent_id"});
    const logged=logs.flatMap(spy=>spy.mock.calls.flat()).map(String).join("\n");
    expect(logged).not.toContain(body.token); expect(logged).not.toContain(presented);
  });

  it("accepts an empty body as well as {}",async()=>{
    database(); expect((await POST(request(token(),A,null))).status).toBe(200);
    database(); expect((await POST(request(token(),A,""))).status).toBe(200);
  });

  it("refuses invalid, forged and expired credentials without touching the database",async()=>{
    database();
    const expired=token([A],{iat:-8*DAY,exp:-60});
    const presented=token();
    for(const bearer of ["bad",`${presented.slice(0,-1)}${presented.endsWith("x")?"y":"x"}`,expired]) expect((await POST(request(bearer))).status).toBe(401);
    delete process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET;
    expect((await POST(request(presented))).status).toBe(401);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("requires a token scoped to exactly the one computer named in the header",async()=>{
    database();
    expect((await POST(request(token([A,B]),A))).status).toBe(403);
    expect((await POST(request(token([A]),B))).status).toBe(403);
    expect((await POST(request(token([A]),""))).status).toBe(403);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("refuses bodies other than an empty object",async()=>{
    database();
    for(const body of ['{"resourceIds":["x"]}',"[]","null","not json","{}".padEnd(2000," ")]) expect((await POST(request(token(),A,body))).status).toBe(400);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("returns 429 when the presented token was issued less than an hour ago",async()=>{
    database();
    const response=await POST(request(token([A],{iat:-(HOUR-120),exp:7*DAY-HOUR})));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(119);
    expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(121);
    expect((await POST(request(token([A],{iat:30,exp:7*DAY}))))?.status).toBe(429);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    database(); expect((await POST(request(token([A],{iat:-HOUR,exp:6*DAY}))))?.status).toBe(200);
  });

  it("refuses a foreign, deleted or deleting computer",async()=>{
    for(const agent of [null,{...OWNED,status:"deleted"},{...OWNED,desired_state:"deleted"}]) {
      const db=database(agent); expect((await POST(request())).status).toBe(404); expect(db.collectorUpsert).not.toHaveBeenCalled();
    }
    const other=database(null); expect((await POST(request(token([A],undefined,"user_2")))).status).toBe(404);
    expect(other.agentQuery.eq).toHaveBeenCalledWith("user_id","user_2");
  });

  it("refuses computers without a verified native producer",async()=>{
    for(const agent of [{...OWNED,type:"aeon"},{...OWNED,type:"hermes"},{...OWNED,computer_substrate:"provider-vm"}]) {
      const db=database(agent); expect((await POST(request())).status).toBe(403); expect(db.collectorUpsert).not.toHaveBeenCalled();
    }
    database({...OWNED,type:"codex",computer_substrate:null}); expect((await POST(request())).status).toBe(200);
  });

  it("still returns the credential when recording the renewal fails",async()=>{
    const db=database(); db.collectorUpsert.mockResolvedValueOnce({error:{message:"denied"}});
    const response=await POST(request()); expect(response.status).toBe(200); expect((await response.json()).token).toMatch(/^hvra_otlp_v1\./);
  });

  it("fails closed on a database error",async()=>{
    const db=database(); db.agentQuery.maybeSingle.mockResolvedValueOnce({data:null,error:{message:"down"}});
    expect((await POST(request())).status).toBe(500);
  });
});
