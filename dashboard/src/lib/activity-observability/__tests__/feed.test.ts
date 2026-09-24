jest.mock("@/lib/supabase",()=>({supabaseAdmin:null}));
import { buildActivitySnapshot, type ActivityAgentRow, type ActivityCollectorRow, type ActivityEventRow } from "../feed";

describe("activity feed normalization",()=>{
  it("keeps deleted-agent history and separates lifecycle availability from telemetry freshness",()=>{
    const snapshot=buildActivitySnapshot({now:new Date("2026-09-21T20:00:00Z"),limit:20,agentRows:[],sessionRows:[],eventRows:[{id:"e1",agent_id:"00000000-0000-4000-8000-000000000001",event:"deleted",agent_type:"codex",detail:{},created_at:"2026-09-01T10:00:00Z"}]});
    expect(snapshot.events[0]).toMatchObject({agentId:"00000000-0000-4000-8000-000000000001",agentName:"codex computer",kind:"lifecycle"});
    expect(snapshot.sources.find(s=>s.id==="hivra-lifecycle")?.state).toBe("active");
    expect(snapshot.sources.find(s=>s.id==="otlp-logs")?.state).toBe("missing");
  });
  it("titles an in-place connection-service update in glossary words, not as a restart",()=>{
    const snapshot=buildActivitySnapshot({now:new Date("2026-09-24T20:00:00Z"),limit:20,agentRows:[],sessionRows:[],eventRows:[{id:"u1",agent_id:"00000000-0000-4000-8000-000000000001",event:"runtime_updated",agent_type:"codex",detail:{inPlace:true},created_at:"2026-09-24T19:00:00Z"}]});
    expect(snapshot.events[0]).toMatchObject({kind:"lifecycle",title:"Connection service updated",outcome:"unknown",needsAttention:false});
    // User-facing Activity copy follows the glossary ("runtime" is not a user word).
    expect(snapshot.events[0].title).not.toMatch(/\bruntimes?\b/i);
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


const NOW=new Date("2026-09-22T12:00:00Z");
const A="00000000-0000-4000-8000-00000000000a";
const ago=(minutes:number)=>new Date(NOW.getTime()-minutes*60_000).toISOString();
const agent=(over:Partial<ActivityAgentRow>={}):ActivityAgentRow=>({id:A,name:"Box",type:"codex",status:"running",computer_substrate:"proxmox-kvm",created_at:"2026-09-01T00:00:00Z",...over});
const collector=(over:Partial<ActivityCollectorRow>={}):ActivityCollectorRow=>({agent_id:A,issued_at:ago(60),credential_expires_at:new Date(NOW.getTime()+86_400_000).toISOString(),last_heartbeat_at:ago(2),last_event_at:null,last_rejected_at:null,last_rejected_reason:null,...over});
function nativeState(a:ActivityAgentRow,row?:ActivityCollectorRow,collectorDegraded=false){
  const snapshot=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[a],collectorRows:row?[row]:[],collectorDegraded});
  return snapshot.resources[0].capabilities.find(c=>c.key==="native_tracing")!;
}
function nativeRow(telemetry:Record<string,unknown>,id="e-native"):ActivityEventRow{
  return {id,agent_id:A,event:"otel_log",agent_type:"codex",created_at:ago(1),detail:{schemaVersion:1,source:"otlp_log",receivedAt:ago(1),agentName:"Box",telemetry:{producer:"codex",runId:"turn-1",traceId:"a".repeat(32),spanId:"b".repeat(16),...telemetry}}};
}

describe("native tracing coverage",()=>{
  it("walks the contract's ordered state machine",()=>{
    expect(nativeState(agent(),collector(),true).state).toBe("degraded");
    expect(nativeState(agent({type:"aeon"}),collector()).state).toBe("unsupported");
    expect(nativeState(agent({computer_substrate:"provider-vm"}),collector()).state).toBe("unsupported");
    expect(nativeState(agent({status:"stopped"}),collector({last_heartbeat_at:ago(600),credential_expires_at:ago(5)}))).toMatchObject({state:"not_running",lastSeenAt:ago(600),expiresAt:ago(5)});
    expect(nativeState(agent(),collector({credential_expires_at:ago(1)})).state).toBe("expired");
    expect(nativeState(agent(),collector({last_heartbeat_at:ago(30),last_rejected_at:ago(3),last_rejected_reason:"expired"})).state).toBe("expired");
    expect(nativeState(agent(),collector({last_heartbeat_at:ago(1),last_rejected_at:ago(3),last_rejected_reason:"expired"})).state).toBe("observed");
    expect(nativeState(agent()).state).toBe("missing");
    expect(nativeState(agent(),collector({issued_at:ago(4),last_heartbeat_at:null})).state).toBe("configured");
    expect(nativeState(agent(),collector({issued_at:ago(11),last_heartbeat_at:null})).state).toBe("missing");
    expect(nativeState(agent(),collector({issued_at:null,last_heartbeat_at:null})).state).toBe("missing");
    expect(nativeState(agent(),collector({last_heartbeat_at:ago(16)}))).toMatchObject({state:"stale",lastSeenAt:ago(16)});
    expect(nativeState(agent(),collector({last_heartbeat_at:ago(14)}))).toMatchObject({state:"observed",lastSeenAt:ago(14)});
  });

  it("says which cause of unsupported applies",()=>{
    expect(nativeState(agent({type:"aeon"}),collector())).toMatchObject({state:"unsupported",reason:"agent_type"});
    expect(nativeState(agent({type:"claude-code",computer_substrate:"provider-vm"}),collector())).toMatchObject({state:"unsupported",reason:"substrate"});
    expect(nativeState(agent({computer_substrate:"provider-vm"}))).toMatchObject({state:"unsupported",reason:"substrate"});
  });

  it("lets a re-issued credential supersede an earlier expired refusal, and says when the computer still presents the old one",()=>{
    const future=new Date(NOW.getTime()+7*86_400_000).toISOString();
    // Refused before the restart re-issued a credential: waiting for the new reporter, not expired.
    expect(nativeState(agent(),collector({issued_at:ago(5),credential_expires_at:future,last_heartbeat_at:null,last_rejected_at:ago(30),last_rejected_reason:"expired"}))).toMatchObject({state:"configured",issuedAt:ago(5),expiresAt:future});
    // Refused after the re-issue: the computer never picked the new credential up.
    expect(nativeState(agent(),collector({issued_at:ago(20),credential_expires_at:future,last_heartbeat_at:ago(2*24*60),last_rejected_at:ago(1),last_rejected_reason:"expired"})))
      .toMatchObject({state:"expired",reason:"expired_credential_presented",issuedAt:ago(20),expiresAt:future});
    expect(nativeState(agent(),collector({credential_expires_at:ago(1)}))).toMatchObject({state:"expired",reason:"credential_ran_out"});
  });

  it("waits for the first report after a re-issue instead of calling a restarted computer stale",()=>{
    const future=new Date(NOW.getTime()+7*86_400_000).toISOString();
    // Checked in two days ago, restarted (re-issued) 4 minutes ago: waiting, not a Needs-attention gap.
    expect(nativeState(agent(),collector({issued_at:ago(4),credential_expires_at:future,last_heartbeat_at:ago(2*24*60)}))).toMatchObject({state:"configured",issuedAt:ago(4),lastSeenAt:ago(2*24*60)});
    // The grace ends: still silent since the re-issue, so it stopped reporting.
    expect(nativeState(agent(),collector({issued_at:ago(11),credential_expires_at:future,last_heartbeat_at:ago(2*24*60)})).state).toBe("stale");
    // A renewal from a healthy reporter keeps its recent check-in.
    expect(nativeState(agent(),collector({issued_at:ago(1),credential_expires_at:future,last_heartbeat_at:ago(3)})).state).toBe("observed");
    // The whole lifecycle: expired, then a restart re-issues, then the first check-in.
    const expiredRow=collector({issued_at:ago(8*24*60),credential_expires_at:ago(60),last_heartbeat_at:ago(2*24*60),last_rejected_at:ago(30),last_rejected_reason:"expired"});
    expect(nativeState(agent(),expiredRow)).toMatchObject({state:"expired",reason:"credential_ran_out"});
    const reissued={...expiredRow,issued_at:ago(2),credential_expires_at:future};
    expect(nativeState(agent(),reissued)).toMatchObject({state:"configured",expiresAt:future});
    expect(nativeState(agent(),{...reissued,last_heartbeat_at:ago(1)}).state).toBe("observed");
  });

  it("tells never set up, set up but never checked in, and could not be installed apart",()=>{
    expect(nativeState(agent())).toEqual({key:"native_tracing",label:"Agent run reporting",state:"missing",reason:"not_set_up"});
    expect(nativeState(agent(),collector({issued_at:null,last_heartbeat_at:null}))).toMatchObject({state:"missing",reason:"not_set_up"});
    expect(nativeState(agent(),collector({issued_at:ago(30),last_heartbeat_at:null}))).toMatchObject({state:"missing",reason:"never_checked_in",issuedAt:ago(30)});
    const failed={last_install_status:"failed",last_install_reason:"transfer_failed"};
    // Failed after the latest issuance: missing even inside the first-report grace, with the installer's code.
    expect(nativeState(agent(),collector({issued_at:ago(4),last_heartbeat_at:null,...failed,last_install_at:ago(3)})))
      .toMatchObject({state:"missing",reason:"install_failed",installFailedAt:ago(3),installFailureReason:"transfer_failed",issuedAt:ago(4)});
    // A later re-issue supersedes the failure; a check-in after it proves a reporter is delivering.
    expect(nativeState(agent(),collector({issued_at:ago(2),last_heartbeat_at:null,...failed,last_install_at:ago(3)})).state).toBe("configured");
    expect(nativeState(agent(),collector({issued_at:ago(60),last_heartbeat_at:ago(1),...failed,last_install_at:ago(3)})).state).toBe("observed");
    expect(nativeState(agent(),collector({issued_at:ago(60),last_heartbeat_at:null,last_install_status:"installed",last_install_reason:null,last_install_at:ago(59)}))).toMatchObject({state:"missing",reason:"never_checked_in"});
    // The failure code is re-validated on read.
    const odd=nativeState(agent(),collector({issued_at:ago(60),last_heartbeat_at:null,last_install_status:"failed",last_install_reason:"Bad reason; see log",last_install_at:ago(58)}));
    expect(odd).toMatchObject({state:"missing",reason:"install_failed"}); expect(odd.installFailureReason).toBeUndefined();
  });

  it("keeps an install failure or a never-used credential from turning into 'expired' after 7 days",()=>{
    const ranOut={issued_at:ago(8*24*60),credential_expires_at:ago(24*60)};
    // The install failed and nothing ever checked in: the credential never reached a working reporter.
    expect(nativeState(agent(),collector({...ranOut,last_heartbeat_at:null,last_install_status:"failed",last_install_reason:"timeout",last_install_at:ago(8*24*60-1)})))
      .toMatchObject({state:"missing",reason:"install_failed",installFailureReason:"timeout"});
    // Issued, never checked in, no install result recorded: still "never checked in", not "expired".
    expect(nativeState(agent(),collector({...ranOut,last_heartbeat_at:null}))).toMatchObject({state:"missing",reason:"never_checked_in"});
    // A reporter that did check in with it and then lapsed is genuinely expired.
    expect(nativeState(agent(),collector({...ranOut,last_heartbeat_at:ago(2*24*60)}))).toMatchObject({state:"expired",reason:"credential_ran_out"});
  });

  it("shows a checking-in computer whose run records are refused for a wrong clock as stale, not healthy",()=>{
    const skewed=nativeState(agent(),collector({last_heartbeat_at:ago(1),last_rejected_reason:"clock_skew",last_rejected_at:ago(1)}));
    expect(skewed).toMatchObject({state:"stale",reason:"clock_skew",lastSeenAt:ago(1)});
    // Once the refusals stop for 15 minutes the computer is healthy again.
    expect(nativeState(agent(),collector({last_heartbeat_at:ago(1),last_rejected_reason:"clock_skew",last_rejected_at:ago(16)})).state).toBe("observed");
  });

  it("never shows the reporter's heartbeat as the agent's last report",()=>{
    const idle=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent()],collectorRows:[collector({last_heartbeat_at:ago(2)})]});
    expect(idle.resources[0].lastSeenAt).toBeUndefined();
    expect(idle.resources[0].capabilities.find(c=>c.key==="native_tracing")).toMatchObject({state:"observed",lastSeenAt:ago(2)});
    const busy=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent()],collectorRows:[collector({last_heartbeat_at:ago(2),last_event_at:ago(7)})]});
    expect(busy.resources[0].lastSeenAt).toBe(ago(7));
  });

  it("never reports a stopped computer as stale, for any capability",()=>{
    const old=ago(55);
    const snapshot=buildActivitySnapshot({now:NOW,limit:20,sessionRows:[],agentRows:[agent({status:"stopped"})],collectorRows:[collector({last_heartbeat_at:old})],
      eventRows:[{id:"g1",agent_id:A,event:"otel_log",agent_type:"codex",created_at:old,detail:{schemaVersion:1,source:"otlp_log",receivedAt:old,telemetry:{title:"Read used"}}},{id:"g2",agent_id:A,event:"otel_span",agent_type:"codex",created_at:old,detail:{schemaVersion:1,source:"otlp_trace",receivedAt:old,telemetry:{}}}]});
    const states=snapshot.resources[0].capabilities.map(c=>c.state);
    expect(states).not.toContain("stale");
    expect(snapshot.resources[0]).toMatchObject({agentType:"codex",status:"stopped"});
    expect(snapshot.sources.filter(s=>s.id.startsWith("otlp-")).map(s=>s.state)).toEqual(["active","active"]);
    const running=buildActivitySnapshot({now:NOW,limit:20,sessionRows:[],agentRows:[agent()],eventRows:[{id:"g1",agent_id:A,event:"otel_log",agent_type:"codex",created_at:old,detail:{schemaVersion:1,source:"otlp_log",receivedAt:old,telemetry:{}}}]});
    expect(running.resources[0].capabilities.find(c=>c.key==="tool_activity")?.state).toBe("stale");
  });

  it("uses the collector's last accepted event for tool coverage when history rows are elsewhere",()=>{
    const snapshot=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent()],collectorRows:[collector({last_event_at:ago(3)})]});
    expect(snapshot.resources[0].capabilities.find(c=>c.key==="tool_activity")).toMatchObject({state:"observed",lastSeenAt:ago(3)});
  });

  it("summarises running Claude Code and Codex computers honestly",()=>{
    const B="00000000-0000-4000-8000-00000000000b", C="00000000-0000-4000-8000-00000000000c", D="00000000-0000-4000-8000-00000000000d";
    const snapshot=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],
      agentRows:[agent(),agent({id:B,type:"claude-code"}),agent({id:C,type:"claude-code"}),agent({id:D,type:"aeon"})],
      collectorRows:[collector(),collector({agent_id:B}),collector({agent_id:C,last_heartbeat_at:ago(40)})]});
    const source=snapshot.sources.find(s=>s.id==="agent-tracing")!;
    expect(source).toMatchObject({label:"Agent run reporting",state:"stale"});
    expect(source.detail).toBe("2 of 3 running Claude Code/Codex computers reporting. 1 stopped reporting.");
    const healthy=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent()],collectorRows:[collector()]});
    expect(healthy.sources.find(s=>s.id==="agent-tracing")).toMatchObject({state:"active",detail:"1 of 1 running Codex computer reporting."});
    const idle=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent({status:"stopped"})],collectorRows:[]});
    expect(idle.sources.find(s=>s.id==="agent-tracing")?.state).toBe("missing");
  });

  it("names the host type when this account's Claude Code and Codex computers cannot report there",()=>{
    const B="00000000-0000-4000-8000-00000000000b";
    const provider=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent({type:"claude-code",computer_substrate:"provider-vm"}),agent({id:B,type:"aeon"})],collectorRows:[]});
    expect(provider.sources.find(s=>s.id==="agent-tracing")).toMatchObject({state:"missing",detail:"Available for Claude Code and Codex computers on Hivra hosts; this account's Claude Code or Codex computers run on a host type that is not supported yet."});
    const none=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent({type:"aeon"})],collectorRows:[]});
    expect(none.sources.find(s=>s.id==="agent-tracing")?.detail).toBe("Available for Claude Code and Codex computers on Hivra hosts; there are none in this account.");
  });

  it("counts computers whose reporter could not be installed apart from ones that are silent",()=>{
    const B="00000000-0000-4000-8000-00000000000b", C="00000000-0000-4000-8000-00000000000c";
    const snapshot=buildActivitySnapshot({now:NOW,limit:20,eventRows:[],sessionRows:[],agentRows:[agent(),agent({id:B}),agent({id:C})],
      collectorRows:[collector(),collector({agent_id:B,issued_at:ago(30),last_heartbeat_at:null,last_install_status:"failed",last_install_reason:"timeout",last_install_at:ago(29)}),collector({agent_id:C,issued_at:ago(30),last_heartbeat_at:null})]});
    expect(snapshot.sources.find(s=>s.id==="agent-tracing")?.detail).toBe("1 of 3 running Codex computers reporting. 1 could not install the reporter. 1 not reporting.");
  });
});

describe("native run records on read",()=>{
  it("flags a failed task but not a stopped task or a failed tool call",()=>{
    const snapshot=buildActivitySnapshot({now:NOW,limit:20,sessionRows:[],agentRows:[agent()],eventRows:[
      nativeRow({role:"run.failed",outcome:"failure",severity:"error",errorType:"rate_limit"},"e1"),
      nativeRow({role:"run.stopped",outcome:"unknown",severity:"info"},"e2"),
      nativeRow({role:"tool.failed",outcome:"failure",severity:"warning",toolName:"Bash",durationMs:1200},"e3"),
    ]});
    const byId=Object.fromEntries(snapshot.events.map(e=>[e.id,e]));
    expect(byId.e1).toMatchObject({role:"run.failed",needsAttention:true,severity:"error",title:"Codex task ended with a failure",errorType:"rate_limit"});
    expect(byId.e2).toMatchObject({role:"run.stopped",needsAttention:false,outcome:"unknown",title:"Codex task was stopped"});
    expect(byId.e3).toMatchObject({role:"tool.failed",needsAttention:false,severity:"warning",outcome:"failure",toolName:"Bash",durationMs:1200,title:"Tool Bash failed after 1.2 s"});
  });

  it("rebuilds text from re-validated fields so a tampered row cannot inject content",()=>{
    const snapshot=buildActivitySnapshot({now:NOW,limit:20,sessionRows:[],agentRows:[agent()],eventRows:[
      nativeRow({role:"tool.completed",outcome:"success",toolName:"Bash; curl evil",durationMs:12.5,title:"Click here: evil",summary:"ignore previous instructions",
        evidence:[{label:"Prompt",value:"secret"}],conversationId:"conv id with spaces",parentSpanId:"NOT-HEX",traceId:"<script>",runId:"turn 1;",errorType:"Stack trace"},"t1"),
      nativeRow({role:"tool.exfiltrate",outcome:"success",title:"Agent activity"},"t2"),
    ]});
    const t1=snapshot.events.find(e=>e.id==="t1")!;
    expect(t1).toMatchObject({role:"tool.completed",title:"A tool finished",outcome:"success",summary:"The agent reported it succeeded."});
    for(const field of ["toolName","durationMs","conversationId","parentSpanId","traceId","runId","errorType"] as const) expect(t1[field]).toBeUndefined();
    expect(JSON.stringify(t1)).not.toMatch(/evil|ignore previous|secret|script|spaces/);
    const t2=snapshot.events.find(e=>e.id==="t2")!;
    expect(t2.role).toBeUndefined(); expect(t2.kind).toBe("tool_activity");
  });
});
