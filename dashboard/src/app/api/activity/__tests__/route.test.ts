import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { getActivitySnapshot } from "@/lib/activity-observability/feed";
import { GET } from "../route";

jest.mock("@clerk/nextjs/server",()=>({auth:jest.fn()}));
jest.mock("@/lib/activity-observability/feed",()=>({decodeActivityCursor:jest.fn((value?:string)=>value?{at:"2026-09-21T00:00:00Z",id:"event-1"}:null),getActivitySnapshot:jest.fn()}));

describe("GET /api/activity",()=>{
  beforeEach(()=>{(auth as unknown as jest.Mock).mockResolvedValue({userId:"user_1"});(getActivitySnapshot as jest.Mock).mockResolvedValue({schemaVersion:1,generatedAt:"2026-09-21T20:00:00Z",events:[],resources:[],sources:[],degraded:false,truncated:false});});
  it("requires a Clerk session",async()=>{(auth as unknown as jest.Mock).mockResolvedValueOnce({userId:null});const response=await GET(new NextRequest("http://localhost/api/activity"));expect(response.status).toBe(401);expect(getActivitySnapshot).not.toHaveBeenCalled();});
  it("scopes reads to the session user with bounded pagination",async()=>{const response=await GET(new NextRequest("http://localhost/api/activity?days=7&limit=25&cursor=opaque"));expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");expect(getActivitySnapshot).toHaveBeenCalledWith("user_1",{days:7,limit:25,cursor:{at:"2026-09-21T00:00:00Z",id:"event-1"}});});
  it("rejects invalid bounds",async()=>{expect((await GET(new NextRequest("http://localhost/api/activity?days=91"))).status).toBe(400);expect(getActivitySnapshot).not.toHaveBeenCalled();});
});
