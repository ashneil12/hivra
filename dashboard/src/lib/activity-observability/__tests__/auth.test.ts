import { mintActivityCollectorToken, verifyActivityCollectorToken } from "../auth";

const SECRET="test-signing-secret-with-at-least-32-characters";
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
    expect(verifyActivityCollectorToken(`Bearer ${token.slice(0,-1)}x`,150)).toBeNull();
    expect(verifyActivityCollectorToken(`Bearer ${token}`,200)).toBeNull();
  });
  it("fails closed when the server secret is absent",()=>{
    const token=mintActivityCollectorToken({userId:"user_1",resourceIds:[RESOURCE],iat:100,exp:200},SECRET);
    delete process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET;
    expect(verifyActivityCollectorToken(`Bearer ${token}`,150)).toBeNull();
  });
});

