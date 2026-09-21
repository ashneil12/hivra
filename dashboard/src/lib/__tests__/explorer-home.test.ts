import {
  DEFAULT_EXPLORER_HOME,
  DEFAULT_EXPLORER_ROOT,
  ROOT_ACCESS_EXPLORER_ROOT,
  resolveExplorerHome,
  resolveExplorerRoot,
} from "../explorer-home";

describe("explorer-home", () => {
  it("starts regular instances inside their instance folder", () => {
    expect(resolveExplorerHome("inst_123")).toBe("/opt/hermes/instances/inst_123");
    expect(resolveExplorerHome("../../../bad")).toBe(DEFAULT_EXPLORER_HOME);
  });

  it("limits regular browsing to /opt but unlocks host root for root access", () => {
    expect(resolveExplorerRoot(false)).toBe("/opt");
    expect(resolveExplorerRoot(false)).toBe(DEFAULT_EXPLORER_ROOT);
    expect(resolveExplorerRoot(true)).toBe(ROOT_ACCESS_EXPLORER_ROOT);
  });
});
