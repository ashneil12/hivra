#!/usr/bin/env node
/**
 * Ask a RUNNING server for the four token documents in every spelling of their
 * addresses, and check which copy each request gets.
 *
 *   node scripts/verify-token-geo-documents.mjs <base-url> --expect restricted|full [--country GB]
 *
 * --expect restricted  The viewer is in a listed country. No request may return a
 *                      full document or its economy section; the four exact addresses
 *                      must return the token-free copy, byte for byte.
 * --expect full        The viewer is not in a listed country. The four exact
 *                      addresses must return the full document, byte for byte.
 * --country CODE       Send x-vercel-ip-country: CODE. A local server reads it as given.
 *                      Vercel's edge replaces it with the real country, so against a
 *                      deployed site leave it out and run from the country you test.
 *
 * The expected bytes come from the repository checkout beside this script, so the
 * server must be built from the same commit. Exits 1 on the first kind of failure
 * it finds, after printing every request that failed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO_DOCUMENTS } from './stage-litepaper.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Text that only a full document has: the economy section of each one.
const LEAK_MARKERS = ['\n## The economy\n', '## 7. The economic layer', '# Hivra tokenomics', 'id="economy"'];
const CONCURRENCY = 6;

function parse(argv) {
  const options = { base: null, expect: null, country: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--expect') options.expect = argv[++index];
    else if (argument === '--country') options.country = argv[++index];
    else if (!argument.startsWith('--') && !options.base) options.base = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.base || !['restricted', 'full'].includes(options.expect)) {
    throw new Error('Usage: node scripts/verify-token-geo-documents.mjs <base-url> --expect restricted|full [--country GB]');
  }
  return options;
}

/** The exact addresses, then every one-character %XX spelling of each, both hex cases, then encoded slashes, a query string and stray slashes. */
export function variantsOf(routes) {
  const exact = new Set(routes);
  const others = new Set([
    '/LITEPAPER%2Emd', '/%4CITEPAPER.md', '/LITEPAPER.m%64', '/WHITEPAPER%2Emd', '/%57HITEPAPER.md',
    '/TOKENOMICS%2Emd', '/%54OKENOMICS.md', '/docs/litepaper/%69ndex.html', '/docs/litepaper/index%2ehtml',
    '/docs/litepaper/index%2Ehtml', '/docs/%6citepaper/index.html', '/docs/litepaper/index.htm%6C',
    '/docs%2Flitepaper/index.html', '/docs/litepaper%2Findex.html', '/docs%2Flitepaper%2Findex.html',
    '/LITEPAPER%252Emd',
  ]);
  for (const route of routes) {
    // Index 0 is the slash that starts the path; without it the address is not a path at all.
    for (let index = 1; index < route.length; index += 1) {
      const code = route.charCodeAt(index).toString(16).padStart(2, '0');
      for (const hex of new Set([code.toUpperCase(), code.toLowerCase()])) {
        others.add(`${route.slice(0, index)}%${hex}${route.slice(index + 1)}`);
      }
    }
    others.add(`${route}?x=1`);
    others.add(`${route}/`);
    others.add(`/${route}`);
  }
  return { exact: [...exact], others: [...others].filter((variant) => !exact.has(variant)) };
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

async function main() {
  const { base, expect, country } = parse(process.argv.slice(2));
  const documents = GEO_DOCUMENTS.map((document) => ({
    ...document,
    fullBytes: readFileSync(path.join(REPO, document.full)),
    restrictedBytes: readFileSync(path.join(REPO, document.restricted)),
  }));
  const { exact, others } = variantsOf(documents.map(({ route }) => route));
  const headers = country ? { 'x-vercel-ip-country': country } : {};

  const fetchOne = async (spelling) => {
    // The URL parser keeps each %XX as written, so the spelling reaches the server as given.
    const response = await fetch(`${new URL(base).origin}${spelling}`, { headers, redirect: 'manual' });
    const body = Buffer.from(await response.arrayBuffer());
    const match = documents.find(({ fullBytes }) => fullBytes.equals(body))
      ? 'full'
      : documents.find(({ restrictedBytes }) => restrictedBytes.equals(body)) ? 'restricted' : 'other';
    return { spelling, status: response.status, match, body, cache: response.headers.get('cache-control') };
  };

  const failures = [];
  const counts = { full: 0, restricted: 0, other: 0 };
  const exactResults = await mapLimit(exact, CONCURRENCY, fetchOne);
  for (const result of exactResults) {
    counts[result.match] += 1;
    const document = documents.find(({ route }) => route === result.spelling);
    const wanted = expect === 'restricted' ? document.restrictedBytes : document.fullBytes;
    if (result.status !== 200 || !wanted.equals(result.body)) {
      failures.push(`${result.spelling}: expected the ${expect} copy, got status ${result.status} and ${result.match} content`);
    }
    if (result.cache !== 'private, no-store') failures.push(`${result.spelling}: Cache-Control is "${result.cache}", expected "private, no-store"`);
  }
  const otherResults = await mapLimit(others, CONCURRENCY, fetchOne);
  for (const result of otherResults) {
    counts[result.match] += 1;
    const text = result.body.toString('utf8');
    if (expect === 'restricted' && (result.match === 'full' || (result.status === 200 && LEAK_MARKERS.some((marker) => text.includes(marker))))) {
      failures.push(`${result.spelling}: a listed country was served token text (status ${result.status}, ${result.match})`);
    }
  }

  console.log(`${exact.length} exact addresses and ${others.length} other spellings requested from ${base}${country ? ` as ${country}` : ''}.`);
  console.log(`Served the full copy ${counts.full} times, the token-free copy ${counts.restricted} times, something else ${counts.other} times.`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Every request was answered as a ${expect} viewer should be.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
