import { createHetznerExternalCleanupReader } from "../client";
const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status});
const pagination = {page:1,per_page:1,previous_page:null,next_page:null,last_page:1,total_entries:0};
function fixture(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) => {
    const path = String(url).replace("https://api.hetzner.cloud/v1/", "");
    if (overrides[path]) return overrides[path]();
    if (path === "servers/42" || path === "ssh_keys/77") return json({error:{code:"not_found"}},404);
    const kind = path.split("?")[0];
    return json({[kind]:[],meta:{pagination}});
  });
}
it("requires exact IDs absent and complete empty project inventory using only explicit-token fixed-origin GETs", async () => {
  const fetchImpl=fixture(), reader=createHetznerExternalCleanupReader("fixture-only", {fetchImpl});
  expect(Object.keys(reader)).toEqual(["verify"]);
  expect(await reader.verify(42,77)).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const [url, init] of fetchImpl.mock.calls as unknown as [string,RequestInit][]) {
    expect(url.startsWith("https://api.hetzner.cloud/v1/")).toBe(true);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.redirect).toBe("error"); expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-only");
  }
});
it.each(["servers/42","ssh_keys/77","servers?per_page=1&page=1","primary_ips?per_page=1&page=1"])("retains claim when %s is nonempty", async path => {
  const kind=path.split("?")[0];
  const fetchImpl=fixture({[path]:()=>json({[kind]:[{id:999}],meta:{pagination:{...pagination,total_entries:1}}})});
  expect(await createHetznerExternalCleanupReader("fixture",{fetchImpl}).verify(42,77)).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});
it.each([
  ()=>new Response("HTML 404",{status:404}),
  ()=>json({error:{code:"not_found"}},403),
  ()=>json({error:{code:"unauthorized"}},401),
  ()=>json({error:{code:"unknown"}},404),
  ()=>Promise.reject(new Error("fixture secret should not escape")),
])("does not reinterpret provider failures as absence", async response => {
  const fetchImpl=fixture({"servers/42":response});
  await expect(createHetznerExternalCleanupReader("fixture",{fetchImpl}).verify(42,77)).rejects.not.toThrow("fixture secret");
});
it.each([
  {},{pagination:{}},{pagination:{...pagination,next_page:2}},{pagination:{...pagination,last_page:2}},
  {pagination:{...pagination,total_entries:1}},{pagination:{...pagination,page:2}},
  {pagination:{...pagination,previous_page:1}},{pagination:{...pagination,per_page:50}},
])("rejects incomplete empty-page evidence %j", async meta => {
  const fetchImpl=fixture({"primary_ips?per_page=1&page=1":()=>json({primary_ips:[],meta})});
  await expect(createHetznerExternalCleanupReader("fixture",{fetchImpl}).verify(42,77)).rejects.toThrow();
});
it.each([0,-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])("rejects unsafe identity %s without reads", async id => {
  const fetchImpl=fixture();
  await expect(createHetznerExternalCleanupReader("fixture",{fetchImpl}).verify(id,77)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
