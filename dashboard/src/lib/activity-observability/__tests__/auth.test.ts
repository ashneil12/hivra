import { randomBytes } from "node:crypto";
import { inspectActivityCollectorToken, mintActivityCollectorToken, verifyActivityCollectorToken } from "../auth";

const SECRET=randomBytes(32).toString("hex");
const RESOURCE="00000000-0000-4000-8000-000000000001";
const ORIGINAL_ENV=process.env;

describe("activity collector capabilities",()=>{
  beforeEach(()=>{process.env={...ORIGINAL_ENV,ACTIVITY_COLLECTOR_SIGNING_SECRET:SECRET};});
  afterAll(()=>{process.env=ORIGINAL_ENV;});
  it("verifies an unexpired signed tenant and resource allowlist",()=>{
    const token=mintActivityCollectorToken({userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200},SECRET);
    expect(verifyActivityCollectorToken(`Bearer ${token}`,150)).toMatchObject({userId:"user_1",resourceIds:[RESOURCE]});
  });
  it("rejects tampering and expiry",()=>{
    const token=mintActivityCollectorToken({userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200},SECRET);
    expect(verifyActivityCollectorToken(`Bearer ${token.slice(0,-1)}${token.endsWith("x")?"y":"x"}`,150)).toBeNull();
    expect(verifyActivityCollectorToken(`Bearer ${token}`,200)).toBeNull();
  });
  it("reports a correctly signed but expired token as expired, with its claims",()=>{
    const token=mintActivityCollectorToken({userId:"user_1",resourceIds:[RESOURCE,RESOURCE],iat:100,exp:200},SECRET);
    expect(inspectActivityCollectorToken(`Bearer ${token}`,150)).toEqual({status:"valid",claims:{v:1,userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200}});
    expect(inspectActivityCollectorToken(`Bearer ${token}`,200)).toEqual({status:"expired",claims:{v:1,userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200}});
  });
  it("checks the signature before trusting any claim, including expiry",()=>{
    const token=mintActivityCollectorToken({userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200},SECRET);
    const tampered=`${token.slice(0,-1)}${token.endsWith("x")?"y":"x"}`;
    expect(inspectActivityCollectorToken(`Bearer ${tampered}`,500)).toEqual({status:"invalid"});
    const foreign=mintActivityCollectorToken({userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200},randomBytes(32).toString("hex"));
    expect(inspectActivityCollectorToken(`Bearer ${foreign}`,500)).toEqual({status:"invalid"});
    const [prefix,,signature]=token.split(".");
    const forgedClaims=Buffer.from(JSON.stringify({v:1,userId:"user_2",resourceIds:[RESOURCE],iat:100,exp:200}),"utf8").toString("base64url");
    expect(inspectActivityCollectorToken(`Bearer ${prefix}.${forgedClaims}.${signature}`,500)).toEqual({status:"invalid"});
    expect(inspectActivityCollectorToken(`Bearer ${token}`,30)).toEqual({status:"invalid"});
    expect(inspectActivityCollectorToken(null,150)).toEqual({status:"invalid"});
    expect(inspectActivityCollectorToken(`Basic ${token}`,150)).toEqual({status:"invalid"});
  });
  it("fails closed when the server secret is absent",()=>{
    const token=mintActivityCollectorToken({userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200},SECRET);
    delete process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET;
    expect(verifyActivityCollectorToken(`Bearer ${token}`,150)).toBeNull();
    expect(inspectActivityCollectorToken(`Bearer ${token}`,500)).toEqual({status:"invalid"});
  });
});

