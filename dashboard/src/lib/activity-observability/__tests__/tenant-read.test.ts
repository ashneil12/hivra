import { supabaseAdmin } from "@/lib/supabase";
import { getActivitySnapshot } from "../feed";

jest.mock("@/lib/supabase",()=>({supabaseAdmin:{from:jest.fn()}}));

describe("activity feed tenant scoping",()=>{
  it("applies the caller user id to every database lane",async()=>{
    const queries:Array<{eq:jest.Mock}>=[];
    (supabaseAdmin!.from as jest.Mock).mockImplementation(()=>{
      const query={select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),gte:jest.fn().mockReturnThis(),neq:jest.fn().mockReturnThis(),order:jest.fn().mockReturnThis(),limit:jest.fn().mockResolvedValue({data:[],error:null})};
      queries.push(query); return query;
    });
    await getActivitySnapshot("user_tenant",{days:30,limit:10,now:new Date("2026-09-21T20:00:00Z")});
    expect(queries).toHaveLength(3);
    for(const query of queries) expect(query.eq).toHaveBeenCalledWith("user_id","user_tenant");
  });
});

