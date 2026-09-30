// The one description of Hivra, used word for word wherever a machine or a
// stranger reads it: Organization JSON-LD, the first line of /llms.txt and the
// /about page. The GitHub repository About and the X bio should say the same.
//
// Owner decision 2026-09-30. It says "open-source" but never names the licence,
// and it names the former brand so searches for "HermesOS" still resolve to the
// right entity. Do not add speed, price or availability claims here: this
// sentence travels into structured data and answer engines.
export const SITE_DESCRIPTION =
  "Hivra (hivra.cloud, formerly HermesOS) is an open-source computer for you and your AI agents, on Hivra Cloud or your own server.";

// The non-affiliation line. Hermes Agent is Nous Research's project, and the
// agent pages run Claude Code and Codex with the user's own Anthropic or OpenAI
// login, so the independence statement is part of the entity facts.
export const NON_AFFILIATION_LINE =
  "Hivra is not affiliated with Nous Research, Anthropic or OpenAI.";
