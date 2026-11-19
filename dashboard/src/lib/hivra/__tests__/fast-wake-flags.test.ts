/** @jest-environment node */
import { isFastWakeEnabled, parseFastWakeFlags } from "../fast-wake-flags";

describe("fast wake flags", () => {
  it("turns nothing on when the flag is unset, empty or unknown", () => {
    expect(parseFastWakeFlags(undefined).size).toBe(0);
    expect(parseFastWakeFlags(null).size).toBe(0);
    expect(parseFastWakeFlags("").size).toBe(0);
    expect(parseFastWakeFlags("on,true,1").size).toBe(0);
    expect(isFastWakeEnabled("fast_qm", undefined)).toBe(false);
  });

  it("turns on only the changes it names, or every one for all", () => {
    const some = parseFastWakeFlags(" Fast_QM , timing ");
    expect([...some].sort()).toEqual(["fast_qm", "timing"]);
    expect(isFastWakeEnabled("early_finish", "fast_qm")).toBe(false);
    expect(parseFastWakeFlags("all").size).toBe(6);
  });

  it("turns on the ingress ticket only when it is named, never through all", () => {
    expect(parseFastWakeFlags("all").has("ingress_ticket")).toBe(false);
    expect(isFastWakeEnabled("ingress_ticket", "all")).toBe(false);
    expect(isFastWakeEnabled("ingress_ticket", "all,ingress_ticket")).toBe(true);
    expect(isFastWakeEnabled("ingress_ticket", " Ingress_Ticket ")).toBe(true);
    expect([...parseFastWakeFlags("ingress_ticket")]).toEqual(["ingress_ticket"]);
    expect(parseFastWakeFlags("all,ingress_ticket").size).toBe(7);
  });

  it("reads the server flag when no value is given", () => {
    const previous = process.env.HIVRA_FAST_WAKE;
    try {
      process.env.HIVRA_FAST_WAKE = "deferred_log";
      expect(isFastWakeEnabled("deferred_log")).toBe(true);
      delete process.env.HIVRA_FAST_WAKE;
      expect(isFastWakeEnabled("deferred_log")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HIVRA_FAST_WAKE;
      else process.env.HIVRA_FAST_WAKE = previous;
    }
  });
});
