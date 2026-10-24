import { findBannedClaims } from "@/lib/tools/copy-rules";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  PLAN_DISPLAY,
  formatPlanSize,
  planSizeParts,
  type PlanSizeKey,
} from "../plan-facts";

const KEYS: PlanSizeKey[] = ["entry", "larger"];

describe("plan display helpers", () => {
  it("names the two sizes Hivra Cloud and More room, never Starter, Pro or Power", () => {
    expect(PLAN_DISPLAY).toEqual({ entry: "Hivra Cloud", larger: "More room" });
    for (const name of Object.values(PLAN_DISPLAY)) {
      expect(name).not.toMatch(/\b(?:Starter|Pro|Power|Studio|Max)\b/);
      expect(findBannedClaims(name)).toEqual([]);
    }
  });

  it("states each size in prose with the words the rest of the site already pins", () => {
    // about/page.test.tsx pins "Hivra Cloud costs $9.99 a month for 2 vCPU and 4 GB of RAM."
    expect(formatPlanSize("entry", "prose")).toBe("$9.99 a month for 2 vCPU and 4 GB of RAM");
    expect(formatPlanSize("larger", "prose")).toBe("$19.99 a month for 4 vCPU and 8 GB of RAM");
    // Prose is the default style.
    expect(formatPlanSize("entry")).toBe(formatPlanSize("entry", "prose"));
  });

  it("builds prose from the billing constants, so it moves with checkout", () => {
    expect(formatPlanSize("entry", "prose")).toBe(`${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}`);
    expect(formatPlanSize("larger", "prose")).toBe(`${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}`);
  });

  it("states each size compactly, with /month only in the compact form", () => {
    expect(formatPlanSize("entry", "compact")).toBe("$9.99/month, 2 vCPU and 4 GB RAM");
    expect(formatPlanSize("larger", "compact")).toBe("$19.99/month, 4 vCPU and 8 GB RAM");
    for (const key of KEYS) {
      expect(formatPlanSize(key, "prose")).not.toMatch(/\/mo/);
      expect(formatPlanSize(key, "compact")).toMatch(/\/month/);
    }
  });

  it("keeps the larger size next to $19.99, so the shared price rule never fires", () => {
    for (const style of ["prose", "compact"] as const) {
      expect(formatPlanSize("larger", style)).toMatch(/^\$19\.99[^.]*4 vCPU and 8 GB/);
    }
  });

  it("passes every banned-claim rule the public pages are scanned against", () => {
    for (const key of KEYS) {
      for (const style of ["prose", "compact"] as const) {
        expect({ key, style, hits: findBannedClaims(formatPlanSize(key, style)) }).toEqual({ key, style, hits: [] });
      }
      const parts = planSizeParts(key);
      for (const text of [parts.cpu, parts.ram, parts.memory, parts.size, parts.slashSize]) {
        expect({ key, text, hits: findBannedClaims(text) }).toEqual({ key, text, hits: [] });
      }
      // A bare "$19.99" is flagged on its own by design (copy-rules.ts): the price parts are
      // safe only when the page text that follows them holds the size in the same sentence.
      for (const price of [parts.price, parts.pricePerMonth]) {
        const text = `${price} ${parts.size}`;
        expect({ key, text, hits: findBannedClaims(text) }).toEqual({ key, text, hits: [] });
      }
    }
  });

  it("writes no dash and no annual price", () => {
    for (const key of KEYS) {
      const everything = [formatPlanSize(key, "prose"), formatPlanSize(key, "compact"), ...Object.values(planSizeParts(key))].join(" ");
      expect(everything).not.toMatch(/[\u2013\u2014]/);
      expect(everything).not.toMatch(/\/yr|per year|yearly/i);
    }
  });

  it("splits each size into parts for layouts that set price and size in separate elements", () => {
    expect(planSizeParts("entry")).toEqual({
      price: "$9.99",
      pricePerMonth: "$9.99/month",
      cpu: "2 vCPU",
      ram: "4 GB",
      memory: "4 GB RAM",
      size: "2 vCPU and 4 GB of RAM",
      slashSize: "2 vCPU / 4 GB",
    });
    expect(planSizeParts("larger")).toEqual({
      price: "$19.99",
      pricePerMonth: "$19.99/month",
      cpu: "4 vCPU",
      ram: "8 GB",
      memory: "8 GB RAM",
      size: "4 vCPU and 8 GB of RAM",
      slashSize: "4 vCPU / 8 GB",
    });
  });

  it("never puts the price and the size in one part", () => {
    for (const key of KEYS) {
      for (const [name, part] of Object.entries(planSizeParts(key))) {
        expect({ key, name, both: /\$\d/.test(part) && /vCPU|GB/.test(part) }).toEqual({ key, name, both: false });
      }
    }
  });
});
