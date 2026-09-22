import { supabaseAdmin } from "@/lib/supabase";
import { getActivitySnapshot } from "../feed";

jest.mock("@/lib/supabase",()=>({supabaseAdmin:{from:jest.fn()}}));

type Call=[string,...unknown[]];
/** A chainable PostgREST stand-in that records every filter and resolves at .limit(). */
function recordingQuery(table:string,calls:Array<{table:string;calls:Call[]}>){
  const entry={table,calls:[] as Call[]}; calls.push(entry);
  const query:Record<string,unknown>={};
  for(const method of ["select","eq","neq","gte","lt","lte","or","not","in","order"]) query[method]=jest.fn((...args:unknown[])=>{entry.calls.push([method,...args]);return query;});
  query.limit=jest.fn(async(...args:unknown[])=>{entry.calls.push(["limit",...args]);return{data:[],error:null};});
  return query;
}

describe("activity feed tenant scoping",()=>{
  it("applies the caller user id to every database lane, including reporter state",async()=>{
    const lanes:Array<{table:string;calls:Call[]}>=[];
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table:string)=>recordingQuery(table,lanes));
    const snapshot=await getActivitySnapshot("user_tenant",{days:30,limit:10,now:new Date("2026-09-21T20:00:00Z")});
    expect(lanes.map(l=>l.table).sort()).toEqual(["hivra_activity_collectors","hivra_agent_events","hivra_agent_events","hivra_agent_events","hivra_agents","hivra_remote_desktop_sessions","hivra_remote_desktop_sessions"]);
    for(const {calls} of lanes) expect(calls).toContainEqual(["eq","user_id","user_tenant"]);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.sources.map(s=>s.id)).toContain("agent-tracing");
  });

  it("selects the agent columns coverage needs and pages history lanes by the requested limit",async()=>{
    const lanes:Array<{table:string;calls:Call[]}>=[];
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table:string)=>recordingQuery(table,lanes));
    await getActivitySnapshot("user_tenant",{days:30,limit:25,now:new Date("2026-09-21T20:00:00Z")});
    const agents=lanes.find(l=>l.table==="hivra_agents")!;
    expect(agents.calls).toContainEqual(["select","id,name,type,status,computer_substrate,created_at"]);
    const history=lanes.filter(l=>l.calls.some(c=>c[0]==="select"&&String(c[1]).startsWith("id,")&&l.table!=="hivra_agents"));
    expect(history).toHaveLength(2);
    for(const lane of history) expect(lane.calls).toContainEqual(["limit",26]);
  });

  it("marks only the collectors lane degraded when reporter state cannot be read",async()=>{
    const lanes:Array<{table:string;calls:Call[]}>=[];
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table:string)=>{
      const query=recordingQuery(table,lanes);
      if(table==="hivra_activity_collectors") query.limit=jest.fn(async()=>({data:null,error:{message:"denied"}}));
      if(table==="hivra_agents") query.limit=jest.fn(async()=>({data:[{id:"00000000-0000-4000-8000-000000000001",name:"Box",type:"codex",status:"running",computer_substrate:"proxmox-kvm",created_at:"2026-09-01T00:00:00Z"}],error:null}));
      return query;
    });
    const snapshot=await getActivitySnapshot("user_tenant",{days:30,limit:10,now:new Date("2026-09-21T20:00:00Z")});
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.sources.find(s=>s.id==="agent-tracing")?.state).toBe("degraded");
    expect(snapshot.sources.find(s=>s.id==="hivra-lifecycle")?.state).toBe("active");
    expect(snapshot.resources[0].capabilities.find(c=>c.key==="native_tracing")?.state).toBe("degraded");
  });
});
