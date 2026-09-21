jest.mock("@/lib/supabase",()=>({supabaseAdmin:null}));
import { buildActivitySnapshot } from "../feed";

describe("activity feed normalization",()=>{
  it("keeps deleted-agent history and separates lifecycle availability from telemetry freshness",()=>{
    const snapshot=buildActivitySnapshot({now:new Date("2026-09-21T20:00:00Z"),limit:20,agentRows:[],sessionRows:[],eventRows:[{id:"e1",agent_id:"00000000-0000-4000-8000-000000000001",event:"deleted",agent_type:"codex",detail:{},created_at:"2026-09-01T10:00:00Z"}]});
    expect(snapshot.events[0]).toMatchObject({agentId:"00000000-0000-4000-8000-000000000001",agentName:"codex computer",kind:"lifecycle"});
    expect(snapshot.sources.find(s=>s.id==="hivra-lifecycle")?.state).toBe("active");
    expect(snapshot.sources.find(s=>s.id==="otlp-logs")?.state).toBe("missing");
  });
  it("preserves pre-agent launch events with a stable unattributed identity",()=>{
    const snapshot=buildActivitySnapshot({now:new Date("2026-09-21T20:00:00Z"),limit:20,agentRows:[],sessionRows:[],eventRows:[{id:"launch-1",agent_id:null,event:"launch_requested",agent_type:"codex",detail:{},created_at:"2026-09-21T19:00:00Z"}]});
    expect(snapshot.events[0]).toMatchObject({agentId:"unattributed:launch-1",agentName:"Unattributed launch",title:"Launch requested"});
    expect(snapshot.events[0].computerId).toBeUndefined();
  });

  it("surfaces a partial lane failure without discarding healthy lanes",()=>{
    const snapshot=buildActivitySnapshot({now:new Date("2026-09-21T20:00:00Z"),limit:20,eventRows:[],eventDegraded:true,sessionRows:[{id:"s1",computer_id:"00000000-0000-4000-8000-000000000001",transport:"selkies-webrtc",input_role:"viewer",created_at:"2026-09-21T19:00:00Z"}],agentRows:[]});
    expect(snapshot.degraded).toBe(true); expect(snapshot.events).toHaveLength(1);
    expect(snapshot.sources.find(s=>s.id==="hivra-lifecycle")?.state).toBe("degraded");
    expect(snapshot.sources.find(s=>s.id==="hivra-desktop")?.state).toBe("active");
  });
});
