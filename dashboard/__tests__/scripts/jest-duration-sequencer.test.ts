import { existsSync } from "fs";
import path from "path";
import DurationShardSequencer, {
  assignShards,
  DEFAULT_SUITE_SECONDS,
} from "../../scripts/jest-duration-sequencer.cjs";
import shardWeights from "../../scripts/jest-shard-weights.json";

const dashboardRoot = path.resolve(__dirname, "../..");

function fakeTest(relativePath: string) {
  return {
    path: path.join(dashboardRoot, relativePath),
    context: { config: { rootDir: dashboardRoot } },
  };
}

const lightSuites = Array.from({ length: 1300 }, (_, index) => `src/__tests__/light-${index}.test.ts`);
const allSuites = [...Object.keys(shardWeights), ...lightSuites];

describe("jest duration shard sequencer", () => {
  it("runs every suite in exactly one shard", () => {
    const sequencer = new DurationShardSequencer();
    const tests = allSuites.map(fakeTest);
    const seen = new Map<string, number>();

    for (let shardIndex = 1; shardIndex <= 4; shardIndex += 1) {
      for (const test of sequencer.shard(tests as never, { shardIndex, shardCount: 4 })) {
        seen.set(test.path, (seen.get(test.path) ?? 0) + 1);
      }
    }

    expect(seen.size).toBe(tests.length);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
  });

  it("assigns the same shards regardless of discovery order", () => {
    const forward = assignShards(allSuites, 4).assignment;
    const reversed = assignShards([...allSuites].reverse(), 4).assignment;
    expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort());
  });

  it("keeps the measured heavy suites balanced across shards", () => {
    const { loads } = assignShards(allSuites, 4);
    const heaviestSuite = Math.max(...Object.values(shardWeights));
    // Longest-first greedy stays within one heavy suite of perfectly even.
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(heaviestSuite);
    expect(Math.max(...loads)).toBeLessThan(
      (Object.values(shardWeights).reduce((sum, seconds) => sum + seconds, 0) +
        lightSuites.length * DEFAULT_SUITE_SECONDS) / 2,
    );
  });

  it("only weights suites that still exist", () => {
    const missing = Object.keys(shardWeights).filter((suite) => !existsSync(path.join(dashboardRoot, suite)));
    expect(missing).toEqual([]);
  });
});
