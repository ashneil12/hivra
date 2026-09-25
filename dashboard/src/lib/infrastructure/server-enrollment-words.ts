/**
 * The three words the server's terminal and "Is this your server?" both show,
 * so the owner answers by matching their terminal instead of recognising an
 * IP address. Chosen by the app with a CSPRNG, never by SQL. This list must
 * stay identical to public.server_enrollment_word_list() in the migration
 * 20260924213000_server_enrollment_command.sql (test-server-enrollment.cjs
 * compares them). 256 short, distinct, lowercase words.
 */
export const SERVER_ENROLLMENT_WORDS = [
  "acorn", "amber", "anchor", "apple", "apricot", "arbor", "arrow", "aspen", "atlas", "autumn",
  "badge", "bamboo", "banjo", "barley", "basil", "beacon", "beaver", "berry", "birch", "bison",
  "blossom", "bonsai", "breeze", "brick", "bridge", "brook", "bronze", "bubble", "buffalo", "butter",
  "cabin", "cactus", "camel", "canal", "candle", "canoe", "canyon", "carbon", "cargo", "carrot",
  "castle", "cedar", "cello", "chalk", "cherry", "cider", "cinder", "citrus", "clover", "cobalt",
  "cocoa", "comet", "copper", "coral", "cotton", "cougar", "coyote", "crane", "crater", "cricket",
  "crystal", "cypress", "daisy", "dawn", "delta", "denim", "desert", "dolphin", "dove", "drift",
  "dune", "eagle", "easel", "echo", "ember", "emerald", "falcon", "feather", "fennel", "fern",
  "ferry", "fiddle", "fig", "finch", "fjord", "flame", "flint", "forest", "fossil", "fox",
  "galaxy", "garden", "garnet", "gecko", "geyser", "ginger", "glacier", "globe", "gondola", "granite",
  "grape", "gravel", "guitar", "harbor", "harvest", "hazel", "heron", "hickory", "honey", "horizon",
  "husky", "iris", "island", "ivory", "jade", "jasmine", "jelly", "jungle", "juniper", "kayak",
  "kelp", "kettle", "kiwi", "koala", "lagoon", "lantern", "lark", "lava", "lemon", "lentil",
  "lichen", "lilac", "lily", "linen", "lotus", "lunar", "lynx", "magnet", "mango", "maple",
  "marble", "meadow", "melon", "mesa", "meteor", "mint", "mist", "moose", "mosaic", "moss",
  "muffin", "nectar", "nickel", "nomad", "nutmeg", "oak", "oasis", "ocean", "olive", "onyx",
  "opal", "orbit", "orchid", "osprey", "otter", "owl", "paddle", "palm", "panda", "papaya",
  "parrot", "peach", "pearl", "pebble", "pelican", "pepper", "petal", "piano", "pine", "pixel",
  "planet", "plaza", "plum", "polar", "pond", "poppy", "prairie", "prism", "puffin", "pumpkin",
  "quartz", "quill", "quince", "rabbit", "radish", "rain", "raven", "reef", "ridge", "river",
  "robin", "rocket", "rose", "ruby", "saddle", "saffron", "sage", "salmon", "sand", "satin",
  "shell", "sierra", "silver", "slate", "sloth", "snow", "solar", "sparrow", "spice", "spruce",
  "star", "stone", "storm", "summit", "sunset", "swan", "tango", "teal", "thistle", "thunder",
  "tiger", "timber", "topaz", "torch", "tulip", "tundra", "turtle", "umber", "valley", "velvet",
  "violet", "walnut", "walrus", "willow", "winter", "wombat", "wren", "yarrow", "yeti", "zebra",
  "zephyr", "zinc", "lime", "cloud", "violin", "raft",
] as const;

export const SERVER_ENROLLMENT_WORDS_PATTERN = /^[a-z]{2,10}-[a-z]{2,10}-[a-z]{2,10}$/;

/** Three words joined by hyphens, each picked uniformly by `randomInt`
 * (node:crypto's in production). */
export function chooseServerEnrollmentWords(randomInt: (max: number) => number): string {
  const words: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const pick = randomInt(SERVER_ENROLLMENT_WORDS.length);
    if (!Number.isInteger(pick) || pick < 0 || pick >= SERVER_ENROLLMENT_WORDS.length) {
      throw new Error("Word choice out of range");
    }
    words.push(SERVER_ENROLLMENT_WORDS[pick]);
  }
  return words.join("-");
}

export function isServerEnrollmentWords(value: unknown): value is string {
  if (typeof value !== "string" || !SERVER_ENROLLMENT_WORDS_PATTERN.test(value)) return false;
  const known = new Set<string>(SERVER_ENROLLMENT_WORDS);
  return value.split("-").every(word => known.has(word));
}
