// Code fences often use a short name for a language (```js, ```py, ```sh).
// The full Prism build resolved those itself. The async build loads each
// grammar by its Prism name the first time a block needs it, so a short name
// is mapped to that name first. Taken from refractor's own alias lists; the
// CodeBlock tests keep the two in step. Aliases of the few grammars the async
// build can't load by name (shell-session, visual-basic and similar) are left
// out: those fences show as plain code.
const ALIASES_BY_LANGUAGE: Record<string, readonly string[]> = {
  antlr4: ["g4"],
  arduino: ["ino"],
  armasm: ["arm-asm"],
  arturo: ["art"],
  asciidoc: ["adoc"],
  avisynth: ["avs"],
  awk: ["gawk"],
  bash: ["sh", "shell"],
  bbcode: ["shortcode"],
  bnf: ["rbnf"],
  bsl: ["oscript"],
  cfscript: ["cfc"],
  cilkc: ["cilk-c"],
  cilkcpp: ["cilk", "cilk-cpp"],
  coffeescript: ["coffee"],
  concurnas: ["conc"],
  csharp: ["cs", "dotnet"],
  cshtml: ["razor"],
  django: ["jinja2"],
  docker: ["dockerfile"],
  dot: ["gv"],
  ejs: ["eta"],
  gettext: ["po"],
  gml: ["gamemakerlanguage"],
  gn: ["gni"],
  handlebars: ["hbs", "mustache"],
  haskell: ["hs"],
  idris: ["idr"],
  ignore: ["gitignore", "hgignore", "npmignore"],
  javascript: ["js"],
  json: ["webmanifest"],
  kotlin: ["kt", "kts"],
  kumir: ["kum"],
  latex: ["context", "tex"],
  lilypond: ["ly"],
  lisp: ["elisp", "emacs", "emacs-lisp"],
  markdown: ["md"],
  markup: ["atom", "html", "mathml", "rss", "ssml", "svg", "xml"],
  moonscript: ["moon"],
  n4js: ["n4jsd"],
  naniscript: ["nani"],
  objectivec: ["objc"],
  openqasm: ["qasm"],
  pascal: ["objectpascal"],
  pcaxis: ["px"],
  peoplecode: ["pcode"],
  powerquery: ["mscript", "pq"],
  purebasic: ["pbfasm"],
  purescript: ["purs"],
  python: ["py"],
  qsharp: ["qs"],
  racket: ["rkt"],
  renpy: ["rpy"],
  rescript: ["res"],
  robotframework: ["robot"],
  ruby: ["rb"],
  sml: ["smlnj"],
  solidity: ["sol"],
  sparql: ["rq"],
  supercollider: ["sclang"],
  tremor: ["trickle", "troy"],
  turtle: ["trig"],
  typescript: ["ts"],
  typoscript: ["tsconfig"],
  unrealscript: ["uc", "uscript"],
  uri: ["url"],
  wolfram: ["mathematica", "nb", "wl"],
  xeora: ["xeoracube"],
  yaml: ["yml"],
};

const LANGUAGE_BY_ALIAS = new Map(
  Object.entries(ALIASES_BY_LANGUAGE).flatMap(([language, aliases]) => aliases.map((alias) => [alias, language] as const)),
);

/** The Prism grammar name for a code fence's language label. */
export function prismLanguage(fence: string): string {
  const name = fence.toLowerCase();
  return LANGUAGE_BY_ALIAS.get(name) ?? name;
}

/** Every short name this maps, for the tests. */
export const PRISM_LANGUAGE_ALIASES: ReadonlyMap<string, string> = LANGUAGE_BY_ALIAS;
