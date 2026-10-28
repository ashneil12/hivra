import { hasSafeHttpAccessUrl, isSafeHttpNavigationUrl } from "@/lib/safe-http-url";

describe("isSafeHttpNavigationUrl", () => {
  it.each([
    "https://agent.example.com/_sidecar/webui-login?exp=1&nonce=abc&sig=def",
    "https://agent.example.com/#iframe_token=secret",
    "https://agent.example.com/?locale=zh-CN&lang=zh-CN#iframe_token=secret",
    "http://localhost:3000/login?token=abc",
    "http://127.0.0.1:8080/webui",
    "https://box.example.com",
  ])("accepts %s", (url) => {
    expect(isSafeHttpNavigationUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "javascript:alert(document.cookie)",
    "data:text/html,<h1>pwned</h1>",
    "data:text/html;base64,PGgxPnB3bmVkPC9oMT4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "file:///C:/Windows/System32",
    "/relative/path",
    "agent.example.com/path",
    "https://",
    "",
    "   ",
    "not a url at all",
  ])("rejects %s", (url) => {
    expect(isSafeHttpNavigationUrl(url)).toBe(false);
  });

  it.each([undefined, null, 0, 42, {}, ["https://agent.example.com"]])(
    "rejects non-string %p",
    (value) => {
      expect(isSafeHttpNavigationUrl(value)).toBe(false);
    },
  );
});

describe("hasSafeHttpAccessUrl", () => {
  it.each([
    "https://box.example.com",
    "https://box-test.example",
    "http://box.local:8080",
  ])("accepts %s", (url) => {
    expect(hasSafeHttpAccessUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<h1>pwned</h1>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "box.example.com",
    " https://box.example.com",
    "https://box.example.com ",
    "https://user:pass@box.example.com",
    "https://user@box.example.com",
    "https://box.example.com/?x=1",
    "https://box.example.com/#frag",
    "https://",
    "",
  ])("rejects %s", (url) => {
    expect(hasSafeHttpAccessUrl(url)).toBe(false);
  });

  it.each([undefined, null, 0, 42, {}, ["https://box.example.com"]])(
    "rejects non-string %p",
    (value) => {
      expect(hasSafeHttpAccessUrl(value)).toBe(false);
    },
  );
});
