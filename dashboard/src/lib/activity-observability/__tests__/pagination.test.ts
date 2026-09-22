import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { decodeActivityCursor, getActivitySnapshot, historyCursorFilter } from "../feed";

jest.mock("@/lib/supabase",()=>({supabaseAdmin:{from:jest.fn()}}));

type Row=Record<string,unknown>&{id:string;created_at:string};
const NOW=new Date("2026-09-21T20:00:00Z");
const cursor=(at:string,id:string)=>Buffer.from(JSON.stringify({at,id}),"utf8").toString("base64url");

/** Microseconds since epoch for a database timestamp, so the fake compares instants the way Postgres does. */
function micros(value:string):bigint{
  const m=/^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!m) throw new Error(`bad timestamp ${value}`);
  return BigInt(Date.parse(`${m[1]}${m[3]}`))*1000n+BigInt((m[2]??"").padEnd(6,"0"));
}

/** Minimal PostgREST semantics for the filters the feed uses, including the cursor or-filter grammar. */
function fakeTable(rows:Row[],limits:number[]){
  const preds:Array<(r:Row)=>boolean>=[]; let aliasReceivedAt=false;
  const cmp=(op:string,column:string,value:string)=>(r:Row)=>{
    if(column==="created_at"){const a=micros(r.created_at),b=micros(value);return op==="lt"?a<b:op==="lte"?a<=b:op==="gte"?a>=b:a===b;}
    const a=String(r[column]);return op==="lt"?a<value:op==="eq"?a===value:false;
  };
  const query={
    select:(columns:string)=>{aliasReceivedAt=columns.includes("received_at:detail->>receivedAt");return query;},
    eq:(c:string,v:string)=>{preds.push(r=>r[c]===v);return query;},
    neq:(c:string,v:string)=>{preds.push(r=>r[c]!==v);return query;},
    gte:(c:string,v:string)=>{preds.push(cmp("gte",c,v));return query;},
    lt:(c:string,v:string)=>{preds.push(cmp("lt",c,v));return query;},
    lte:(c:string,v:string)=>{preds.push(cmp("lte",c,v));return query;},
    in:(c:string,v:string[])=>{preds.push(r=>v.includes(String(r[c])));return query;},
    not:(c:string,op:string,v:string)=>{const list=v.slice(1,-1).split(",");preds.push(r=>!list.includes(String(r[c])));return query;},
    or:(filter:string)=>{
      const m=/^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/.exec(filter);
      if(!m) throw new Error(`unexpected or filter ${filter}`);
      preds.push(r=>cmp("lt","created_at",m[1])(r)||(cmp("eq","created_at",m[2])(r)&&r.id<m[3]));return query;
    },
    order:()=>query,
    limit:async(n:number)=>{
      limits.push(n);
      const data=rows.filter(r=>preds.every(p=>p(r))).sort((a,b)=>{const d=micros(b.created_at)-micros(a.created_at);return d!==0n?(d>0n?1:-1):a.id<b.id?1:a.id>b.id?-1:0;}).slice(0,n)
        .map(r=>aliasReceivedAt?{...r,received_at:(r.detail as {receivedAt?:string}|undefined)?.receivedAt??null}:r);
      return {data,error:null};
    },
  };
  return query;
}

function pgTime(ms:number,fraction?:string){return `${new Date(ms).toISOString().slice(0,19)}${fraction?`.${fraction}`:""}+00:00`;}

describe("activity history pagination",()=>{
  it("expresses the history order per lane in SQL",()=>{
    const at="2026-09-21T19:00:00.123456+00:00", id="00000000-0000-4000-8000-000a00000000";
    expect(historyCursorFilter({at,id},"events")).toEqual({op:"or",filter:`created_at.lt."${at}",and(created_at.eq."${at}",id.lt."${id}")`});
    expect(historyCursorFilter({at,id},"desktop")).toEqual({op:"lte",at});
    expect(historyCursorFilter({at,id:`desktop:${id}`},"events")).toEqual({op:"lt",at});
    expect(historyCursorFilter({at,id:`desktop:${id}`},"desktop")).toEqual({op:"or",filter:`created_at.lt."${at}",and(created_at.eq."${at}",id.lt."${id}")`});
    expect(historyCursorFilter(null,"events")).toBeNull();
  });

  it("refuses cursors that could alter the SQL filter",()=>{
    const id="00000000-0000-4000-8000-000a00000000";
    expect(decodeActivityCursor(cursor("2026-09-21T19:00:00+00:00",id))).toEqual({at:"2026-09-21T19:00:00+00:00",id});
    expect(decodeActivityCursor(cursor("2026-09-21T19:00:00.5Z",`desktop:${id}`))).not.toBeNull();
    for(const bad of [cursor("2026-09-21T19:00:00+00:00",`${id}"),id.not.is.null,and(id.eq."x`),cursor('2026-09-21T19:00:00+00:00",and(x',id),cursor("Mon Sep 21 2026",id),cursor("2026-09-21T19:00:00+00:00","event-1"),cursor("2026-09-21T19:00:00+00:00",`desktop:${id},x`),"%%%"]) {
      expect(decodeActivityCursor(bad)).toBeNull();
    }
  });

  it("reaches every event and desktop row beyond the old 1000-row window exactly once, in order",async()=>{
    const base=NOW.getTime()-60_000;
    const events:Row[]=Array.from({length:1300},(_,i)=>({id:randomUUID(),agent_id:null,user_id:"user_1",event:"started",agent_type:"codex",detail:{},created_at:pgTime(base-Math.floor(i/3)*1000,i%5===0?"5":i%7===0?"123456":undefined)}));
    // Same seconds as the event rows, so cross-lane ties at one instant are exercised.
    const sessions:Row[]=Array.from({length:400},(_,j)=>({id:randomUUID(),user_id:"user_1",computer_id:"00000000-0000-4000-8000-000000000001",transport:"selkies-webrtc",input_role:"viewer",created_at:pgTime(base-j*1000,j%4===0?"5":undefined)}));
    const foreign:Row[]=[{id:randomUUID(),agent_id:null,user_id:"user_other",event:"started",agent_type:"codex",detail:{},created_at:pgTime(base)}];
    const limits:number[]=[];
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table:string)=>fakeTable(table==="hivra_agent_events"?[...events,...foreign]:table==="hivra_remote_desktop_sessions"?sessions:[],limits));

    const seen:string[]=[]; let next:string|undefined; let pages=0;
    do {
      const snapshot=await getActivitySnapshot("user_1",{days:30,limit:200,now:NOW,cursor:next?decodeActivityCursor(next):null});
      seen.push(...snapshot.events.map(e=>e.id)); next=snapshot.nextCursor; pages++;
      if(next) expect(decodeActivityCursor(next)).not.toBeNull();
    } while(next&&pages<20);

    const expected=[...events.map(r=>({id:r.id,at:micros(r.created_at),lane:1})),...sessions.map(r=>({id:`desktop:${r.id}`,at:micros(r.created_at),lane:0}))]
      .sort((a,b)=>a.at!==b.at?(b.at>a.at?1:-1):a.lane!==b.lane?b.lane-a.lane:a.id<b.id?1:a.id>b.id?-1:0).map(r=>r.id);
    expect(seen).toHaveLength(1700);
    expect(new Set(seen).size).toBe(1700);
    expect(seen).toEqual(expected);
    expect(pages).toBe(9);
    expect(limits).toContain(201);
  });
});
