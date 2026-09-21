import {
  getInstanceMeteringRollup,
  recordInstanceMeteringSample,
  type MeteringDb,
  type InstanceMeteringSampleRow,
} from "@/lib/services/instance-metering";

interface FakeSelectChain {
  eq: jest.Mock;
  gte: jest.Mock;
  order: jest.Mock;
}

function createFakeDb(rows: InstanceMeteringSampleRow[]): {
  db: MeteringDb;
  inserted: Record<string, unknown>[];
  selectArgs: { columns?: unknown; eq: { column: string; value: unknown } | null; gte?: { column: string; value: unknown } | null; order?: { column: string; opts?: unknown } | null };
} {
  const inserted: Record<string, unknown>[] = [];
  const selectArgs: ReturnType<typeof createFakeDb>["selectArgs"] = {
    eq: null,
  };

  const insertHandler = (row: Record<string, unknown> | Record<string, unknown>[]) => {
    if (Array.isArray(row)) {
      inserted.push(...row);
    } else {
      inserted.push(row);
    }
    return Promise.resolve({ error: null });
  };

  const fakeFrom = (table: string) => {
    if (table !== "instance_metering_events") {
      throw new Error(`Unexpected table ${table}`);
    }

    const select = (columns?: unknown) => {
      selectArgs.columns = columns;
      const chain: FakeSelectChain = {
        eq: jest.fn((column: string, value: unknown) => {
          selectArgs.eq = { column, value };
          return chain;
        }),
        gte: jest.fn((column: string, value: unknown) => {
          selectArgs.gte = { column, value };
          return chain;
        }),
        order: jest.fn((column: string, opts?: unknown) => {
          selectArgs.order = { column, opts };
          return Promise.resolve({ data: rows, error: null });
        }),
      };
      return chain;
    };

    return {
      insert: insertHandler,
      select,
    };
  };

  return {
    db: { from: fakeFrom } as unknown as MeteringDb,
    inserted,
    selectArgs,
  };
}

describe("recordInstanceMeteringSample", () => {
  it("inserts a sanitized row with defaults applied", async () => {
    const { db, inserted } = createFakeDb([]);

    const result = await recordInstanceMeteringSample(
      {
        instance_id: "inst_1",
        cpu_seconds_total: 12.34,
        ram_peak_bytes: 1024.7,
        disk_used_bytes: 2048.9,
        runtime_seconds: 60,
        net_out_bytes: 9999.5,
      },
      db
    );

    expect(result).toEqual({ ok: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      instance_id: "inst_1",
      cpu_seconds_total: 12.34,
      ram_peak_bytes: 1024,
      disk_used_bytes: 2048,
      net_out_bytes: 9999,
      source: "proxmox",
      metadata: {},
    });
    // No guest-sourced total supplied => column omitted (left NULL).
    expect(inserted[0]).not.toHaveProperty("disk_total_bytes");
  });

  it("persists a guest-sourced disk_total_bytes (floored), omitting it when zero", async () => {
    const withTotal = createFakeDb([]);
    await recordInstanceMeteringSample(
      {
        instance_id: "inst_1",
        cpu_seconds_total: 0,
        ram_peak_bytes: 0,
        disk_used_bytes: 100,
        disk_total_bytes: 31_138_512_896.9,
        runtime_seconds: 0,
        net_out_bytes: 0,
      },
      withTotal.db
    );
    expect(withTotal.inserted[0].disk_total_bytes).toBe(31_138_512_896);

    const withoutTotal = createFakeDb([]);
    await recordInstanceMeteringSample(
      {
        instance_id: "inst_1",
        cpu_seconds_total: 0,
        ram_peak_bytes: 0,
        disk_used_bytes: 100,
        disk_total_bytes: 0,
        runtime_seconds: 0,
        net_out_bytes: 0,
      },
      withoutTotal.db
    );
    expect(withoutTotal.inserted[0]).not.toHaveProperty("disk_total_bytes");
  });

  it("returns an error when no db is supplied", async () => {
    const result = await recordInstanceMeteringSample(
      {
        instance_id: "inst_x",
        cpu_seconds_total: 0,
        ram_peak_bytes: 0,
        disk_used_bytes: 0,
        runtime_seconds: 0,
        net_out_bytes: 0,
      },
      null
    );
    expect(result.ok).toBe(false);
  });
});

describe("getInstanceMeteringRollup", () => {
  it("returns an empty rollup when there are no samples", async () => {
    const { db } = createFakeDb([]);

    const rollup = await getInstanceMeteringRollup("inst_1", null, db);

    expect(rollup).toEqual({
      sample_count: 0,
      first_sampled_at: null,
      last_sampled_at: null,
      cpu_seconds_total: 0,
      net_out_bytes: 0,
      runtime_seconds: 0,
      ram_peak_bytes: 0,
      disk_used_bytes_last: 0,
      disk_total_bytes_last: 0,
      disk_used_is_capacity_fallback_last: false,
    });
  });

  it("computes deltas for monotonic counters and peak for RAM", async () => {
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T10:00:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: 1024,
        disk_used_bytes: 2048,
        runtime_seconds: 600,
        net_out_bytes: 1_000_000,
      },
      {
        sampled_at: "2026-04-29T10:30:00.000Z",
        cpu_seconds_total: 250,
        ram_peak_bytes: 4096,
        disk_used_bytes: 2200,
        runtime_seconds: 2400,
        net_out_bytes: 1_500_000,
      },
      {
        sampled_at: "2026-04-29T11:00:00.000Z",
        cpu_seconds_total: 400,
        ram_peak_bytes: 2048,
        disk_used_bytes: 2300,
        disk_total_bytes: 32_000,
        runtime_seconds: 4200,
        net_out_bytes: 2_500_000,
      },
    ];

    const { db, selectArgs } = createFakeDb(rows);

    const rollup = await getInstanceMeteringRollup("inst_1", null, db);

    expect(selectArgs.eq).toEqual({ column: "instance_id", value: "inst_1" });
    expect(selectArgs.order).toEqual({ column: "sampled_at", opts: { ascending: true } });
    expect(rollup).toEqual({
      sample_count: 3,
      first_sampled_at: "2026-04-29T10:00:00.000Z",
      last_sampled_at: "2026-04-29T11:00:00.000Z",
      cpu_seconds_total: 300, // 400 - 100
      net_out_bytes: 1_500_000, // 2.5M - 1M
      runtime_seconds: 3600, // 4200 - 600
      ram_peak_bytes: 4096, // max across rows
      disk_used_bytes_last: 2300,
      disk_total_bytes_last: 32_000, // latest sample's guest df total
      disk_used_is_capacity_fallback_last: false,
    });
  });

  it("reports disk_total_bytes_last=0 when the latest sample predates the column (NULL total)", async () => {
    // Post-migration / pre-redeploy window: old cron code wrote a fresh row
    // WITHOUT disk_total_bytes, so the latest sample's total is NULL. The
    // rollup must coerce that to 0 so the storage banner stays silent rather
    // than dividing a real used value by a stale reservation size.
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T10:00:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: 1024,
        disk_used_bytes: 2048,
        disk_total_bytes: 42_949_672_960, // older sample DID have a real total
        runtime_seconds: 600,
        net_out_bytes: 1_000_000,
      },
      {
        sampled_at: "2026-04-29T10:30:00.000Z",
        cpu_seconds_total: 200,
        ram_peak_bytes: 2048,
        disk_used_bytes: 41_000_000_000, // ~95% of the OLD total — would be "critical" if mis-divided
        disk_total_bytes: null, // latest sample: not guest-sourced
        runtime_seconds: 2400,
        net_out_bytes: 1_500_000,
      },
    ];
    const { db } = createFakeDb(rows);

    const rollup = await getInstanceMeteringRollup("inst_null_total", null, db);

    expect(rollup.disk_used_bytes_last).toBe(41_000_000_000);
    expect(rollup.disk_total_bytes_last).toBe(0); // latest wins; NULL → 0 → no banner
  });

  it("surfaces disk_total_bytes + capacity-fallback flag from the LAST sample's metadata", async () => {
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T10:00:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: 1024,
        disk_used_bytes: 2048,
        runtime_seconds: 600,
        net_out_bytes: 1000,
        // Older sample with no metadata — should be ignored in favor of the last.
        metadata: null,
      },
      {
        sampled_at: "2026-04-29T10:30:00.000Z",
        cpu_seconds_total: 200,
        ram_peak_bytes: 2048,
        disk_used_bytes: 4096,
        runtime_seconds: 1200,
        net_out_bytes: 2000,
        metadata: {
          disk_total_bytes: 831_023_177_728,
          disk_used_is_capacity_fallback: false,
        },
      },
    ];
    const { db } = createFakeDb(rows);

    const rollup = await getInstanceMeteringRollup("inst_disk", null, db);

    expect(rollup.disk_total_bytes_last).toBe(831_023_177_728);
    expect(rollup.disk_used_is_capacity_fallback_last).toBe(false);
  });

  it("flags a capacity-fallback last sample and tolerates JSON-string metadata", async () => {
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T10:30:00.000Z",
        cpu_seconds_total: 200,
        ram_peak_bytes: 2048,
        disk_used_bytes: 4096,
        runtime_seconds: 1200,
        net_out_bytes: 2000,
        // Supabase can hand JSONB back as a string; parseMetadata should cope.
        metadata: JSON.stringify({
          disk_total_bytes: "42949672960",
          disk_used_is_capacity_fallback: true,
        }),
      },
    ];
    const { db } = createFakeDb(rows);

    const rollup = await getInstanceMeteringRollup("inst_fallback", null, db);

    expect(rollup.disk_total_bytes_last).toBe(42949672960);
    expect(rollup.disk_used_is_capacity_fallback_last).toBe(true);
  });

  it("defaults disk metadata fields when metadata is missing or malformed", async () => {
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T10:30:00.000Z",
        cpu_seconds_total: 200,
        ram_peak_bytes: 2048,
        disk_used_bytes: 4096,
        runtime_seconds: 1200,
        net_out_bytes: 2000,
        metadata: "not-json",
      },
    ];
    const { db } = createFakeDb(rows);

    const rollup = await getInstanceMeteringRollup("inst_bad_meta", null, db);

    expect(rollup.disk_total_bytes_last).toBe(0);
    expect(rollup.disk_used_is_capacity_fallback_last).toBe(false);
  });

  it("filters via gte when a since cutoff is supplied", async () => {
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T11:00:00.000Z",
        cpu_seconds_total: 50,
        ram_peak_bytes: 2048,
        disk_used_bytes: 1000,
        runtime_seconds: 600,
        net_out_bytes: 500,
      },
      {
        sampled_at: "2026-04-29T11:30:00.000Z",
        cpu_seconds_total: 90,
        ram_peak_bytes: 4096,
        disk_used_bytes: 1200,
        runtime_seconds: 2400,
        net_out_bytes: 1500,
      },
    ];
    const { db, selectArgs } = createFakeDb(rows);

    const since = new Date("2026-04-29T11:00:00.000Z");
    const rollup = await getInstanceMeteringRollup("inst_2", since, db);

    expect(selectArgs.gte).toEqual({
      column: "sampled_at",
      value: since.toISOString(),
    });
    expect(rollup.cpu_seconds_total).toBe(40);
    expect(rollup.runtime_seconds).toBe(1800);
  });

  it("clamps negative deltas to zero (defensive against counter resets)", async () => {
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T10:00:00.000Z",
        cpu_seconds_total: 500,
        ram_peak_bytes: 1024,
        disk_used_bytes: 2048,
        runtime_seconds: 9000,
        net_out_bytes: 5_000_000,
      },
      {
        sampled_at: "2026-04-29T10:30:00.000Z",
        cpu_seconds_total: 50, // VM rebooted, counter reset
        ram_peak_bytes: 2048,
        disk_used_bytes: 2048,
        runtime_seconds: 60,
        net_out_bytes: 100,
      },
    ];
    const { db } = createFakeDb(rows);

    const rollup = await getInstanceMeteringRollup("inst_reset", null, db);

    expect(rollup.cpu_seconds_total).toBe(0);
    expect(rollup.net_out_bytes).toBe(0);
    expect(rollup.runtime_seconds).toBe(0);
    expect(rollup.ram_peak_bytes).toBe(2048);
    expect(rollup.disk_used_bytes_last).toBe(2048);
  });

  it("parses numeric strings (Postgres numeric/bigint) safely", async () => {
    const rows: InstanceMeteringSampleRow[] = [
      {
        sampled_at: "2026-04-29T10:00:00.000Z",
        cpu_seconds_total: "10.5",
        ram_peak_bytes: "1024",
        disk_used_bytes: "100",
        runtime_seconds: "60",
        net_out_bytes: "500",
      },
      {
        sampled_at: "2026-04-29T10:05:00.000Z",
        cpu_seconds_total: "20.5",
        ram_peak_bytes: "1500",
        disk_used_bytes: "150",
        runtime_seconds: "360",
        net_out_bytes: "1500",
      },
    ];
    const { db } = createFakeDb(rows);

    const rollup = await getInstanceMeteringRollup("inst_strings", null, db);

    expect(rollup.cpu_seconds_total).toBe(10);
    expect(rollup.net_out_bytes).toBe(1000);
    expect(rollup.runtime_seconds).toBe(300);
    expect(rollup.ram_peak_bytes).toBe(1500);
  });
});
