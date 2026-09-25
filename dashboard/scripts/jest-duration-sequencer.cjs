const path = require("node:path");
const Sequencer = require("@jest/test-sequencer").default;
const shardWeights = require("./jest-shard-weights.json");

// Suites missing from the weights file cost about 0.3 s each on a hosted
// runner (Dashboard CI run 36076041957, 2026-09-25).
const DEFAULT_SUITE_SECONDS = 0.3;

function relativeTestPath(test) {
  return path.relative(test.context.config.rootDir, test.path).split(path.sep).join("/");
}

/**
 * Split suites across `--shard=i/n` by measured duration instead of Jest's
 * default path hash. A handful of SQL and script suites take 20-110 s each and
 * the hash split put most of them in one shard, so that shard ran ~2.5x longer
 * than the rest. Greedy longest-first assignment keeps shards within a few
 * seconds of each other.
 *
 * Every shard sees the same test list and computes the same assignment, so
 * each suite runs in exactly one shard. Stale or missing weights only affect
 * balance, never coverage.
 */
function assignShards(testPaths, shardCount, weights = shardWeights) {
  const loads = new Array(shardCount).fill(0);
  const assignment = new Map();
  const ordered = [...new Set(testPaths)]
    .map((testPath) => ({ testPath, seconds: weights[testPath] ?? DEFAULT_SUITE_SECONDS }))
    .sort((a, b) => b.seconds - a.seconds || (a.testPath < b.testPath ? -1 : a.testPath > b.testPath ? 1 : 0));

  for (const { testPath, seconds } of ordered) {
    let target = 0;
    for (let index = 1; index < shardCount; index += 1) {
      if (loads[index] < loads[target]) target = index;
    }
    loads[target] += seconds;
    assignment.set(testPath, target);
  }

  return { assignment, loads };
}

class DurationShardSequencer extends Sequencer {
  shard(tests, { shardIndex, shardCount }) {
    const { assignment } = assignShards(tests.map(relativeTestPath), shardCount);
    return tests.filter((test) => assignment.get(relativeTestPath(test)) === shardIndex - 1);
  }
}

module.exports = DurationShardSequencer;
module.exports.assignShards = assignShards;
module.exports.DEFAULT_SUITE_SECONDS = DEFAULT_SUITE_SECONDS;
