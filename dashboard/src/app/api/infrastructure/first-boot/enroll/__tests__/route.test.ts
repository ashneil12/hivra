import { NextRequest } from "next/server";
import { FirstBootReceiverError } from "@/lib/infrastructure/first-boot-receiver";
import { POST } from "../route";
const mockReceive = jest.fn(); const mockLimit = jest.fn(); const mockWarn = jest.fn();
jest.mock("@/lib/infrastructure/first-boot-receiver",()=>({
  ...jest.requireActual("@/lib/infrastructure/first-boot-receiver"),
  receiveFirstBootEnrollment:(...args:unknown[])=>mockReceive(...args),
}));
jest.mock("@/lib/rate-limit",()=>({enforceRateLimit:(...args:unknown[])=>mockLimit(...args),getIP:()=>"203.0.113.1"}));
jest.mock("@/lib/logger",()=>({log:{warn:(...args:unknown[])=>mockWarn(...args)}}));
const url="https://canary.hermesos.cloud/api/infrastructure/first-boot/enroll";
const token="hbe1_"+"x".repeat(43);
const payload={version:1,orderId:"22222222-2222-4222-8222-222222222222",attemptId:"44444444-4444-4444-8444-444444444444",
  providerServerId:"42",hostPublicKey:"public-key-checked-by-service"};
const ack={version:1,accepted:true,orderId:payload.orderId,attemptId:payload.attemptId,hostFingerprintSha256:"SHA256:test"};
const request=(value:unknown=payload)=>new NextRequest(url,{method:"POST",headers:{
  authorization:"Bearer "+token,"content-type":"application/json",
},body:JSON.stringify(value)});
beforeEach(()=>{jest.clearAllMocks();mockLimit.mockReturnValue({success:true});mockReceive.mockResolvedValue(ack);});
afterEach(()=>jest.useRealTimers());

it("allows the machine header proof without a browser session and returns the exact helper wire shape",async()=>{
  const r=await POST(request());expect(r.status).toBe(200);expect(await r.json()).toEqual(ack);
  expect(mockReceive).toHaveBeenCalledWith({token,registration:payload});
  expect(r.headers.get("cache-control")).toBe("no-store");expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
});
it.each(["",token,"Basic "+token,"Bearer wrong","Bearer "+token+", other","bearer "+token])("rejects invalid authorization %s before service access",async header=>{
  const r=request();r.headers.set("authorization",header);
  expect((await POST(r)).status).toBe(401);expect(mockReceive).not.toHaveBeenCalled();
});
it("never substitutes a logged-in cookie or URL proof, and rejects browser-origin requests",async()=>{
  const r=request();r.headers.delete("authorization");r.headers.set("cookie","__session=not-authorization");
  expect((await POST(r)).status).toBe(401);
  const query=new NextRequest(url+"?token="+token,{method:"POST"});
  expect((await POST(query)).status).toBe(403);
  for(const header of ["origin","sec-fetch-site"]) {
    const browser=request();browser.headers.set(header,"same-origin");
    expect((await POST(browser)).status).toBe(403);
  }
  expect(mockReceive).not.toHaveBeenCalled();
});
it("requires uncompressed strict JSON and rejects declared or streamed oversized bodies",async()=>{
  for(const type of ["text/plain","application/json; charset=utf-8",""]) {
    const r=request();r.headers.set("content-type",type);expect((await POST(r)).status).toBe(415);
  }
  const zipped=request();zipped.headers.set("content-encoding","gzip");expect((await POST(zipped)).status).toBe(415);
  const declared=request();declared.headers.set("content-length","2049");expect((await POST(declared)).status).toBe(413);
  expect((await POST(request({padding:"x".repeat(2049)}))).status).toBe(413);
  const invalid=new NextRequest(url,{method:"POST",headers:request().headers,body:"{"});
  expect((await POST(invalid)).status).toBe(400);expect(mockReceive).not.toHaveBeenCalled();
});
it("bounds slow request streams even outside a platform-enforced execution timeout",async()=>{
  jest.useFakeTimers();const cancel=jest.fn();
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode("{"));},cancel});
  const init={method:"POST",headers:request().headers,body,duplex:"half" as const};
  const r=new NextRequest(url,init);
  const pending=POST(r);await jest.advanceTimersByTimeAsync(5000);
  const response=await pending;expect(response.status).toBe(408);
  expect(cancel).toHaveBeenCalledTimes(1);expect(mockReceive).not.toHaveBeenCalled();
});
it("returns promptly on oversized streams even when the sender's cancel hook stalls",async()=>{
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(2049));},cancel(){return new Promise(()=>{});}});
  const init={method:"POST",headers:request().headers,body,duplex:"half" as const};
  const r=new NextRequest(url,init);
  expect((await POST(r)).status).toBe(413);expect(mockReceive).not.toHaveBeenCalled();
});
it("limits inbound requests before body or service access",async()=>{
  mockLimit.mockReturnValue({success:false});const r=await POST(request());
  expect(r.status).toBe(429);expect(r.headers.get("cache-control")).toBe("no-store");
  expect(mockReceive).not.toHaveBeenCalled();
});
it.each([["rejected",401],["unavailable",503],["rate_limited",429]] as const)("returns only safe %s errors",async(code,status)=>{
  mockReceive.mockRejectedValue(new FirstBootReceiverError(code));const r=await POST(request());
  expect(r.status).toBe(status);expect(await r.json()).toEqual({accepted:false});
});
it("never logs or returns an unexpected exception containing secrets",async()=>{
  mockReceive.mockRejectedValue(new Error("provider-secret "+token));const r=await POST(request());
  expect(r.status).toBe(503);expect(await r.json()).toEqual({accepted:false});
  expect(mockWarn).toHaveBeenCalledWith("First-boot enrollment temporarily unavailable",{
    source:"first-boot-enroll",failureType:"unavailable"});
  expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(token);
});
