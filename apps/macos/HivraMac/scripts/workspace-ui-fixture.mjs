#!/usr/bin/env node
// Local native-shell QA only. Never serve this fixture from Canary/production.
// Run: node apps/macos/HivraMac/scripts/workspace-ui-fixture.mjs
// Then add http://127.0.0.1:43187/dashboard to the isolated native QA app.
import http from 'node:http';
const portValue = process.env.HIVRA_UI_FIXTURE_PORT ?? '43187';
if (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535) {
  throw new Error('HIVRA_UI_FIXTURE_PORT must be an integer from 1 to 65535.');
}
const port = Number(portValue);
const resources = [
  { uid: 'h-qa-hermes-agent', id: 'qa-hermes-agent', source: 'hermes', kind: 'agent', name: 'QA Hermes agent', description: 'UI fixture only', status: 'running', href: '/dashboard/instances/qa-hermes-agent' },
  { uid: 'x-qa-code-agent', id: 'qa-code-agent', source: 'hivra', kind: 'agent', name: 'QA Code agent', description: 'UI fixture only', status: 'running', href: '/dashboard/agent/qa-code-agent' },
  { uid: 'x-qa-linux-computer', id: 'qa-linux-computer', source: 'hivra', kind: 'computer', name: 'QA Linux computer', description: 'UI fixture only', status: 'running', href: '/dashboard/agent/qa-linux-computer' },
  { uid: 'x-qa-windows-computer', id: 'qa-windows-computer', source: 'hivra', kind: 'computer', name: 'QA Windows computer', description: 'UI fixture only', status: 'stopped', href: '/dashboard/agent/qa-windows-computer' },
];
const html = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hivra native UI fixture — QA only</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;color:#f2eee8;background:#101010}
*{box-sizing:border-box}body{margin:0;padding:24px}main{max-width:940px;margin:auto}
.qa{border:1px solid #9e4545;background:#291516;padding:12px 16px;font:12px/1.5 ui-monospace,monospace}
h1{font:normal 32px/1.2 Georgia,serif;margin:20px 0 10px}p{color:#bdb8b2;line-height:1.5}
button,a{font:inherit;min-height:40px;padding:9px 12px;border:1px solid #615952;background:#191919;color:#f2eee8;text-decoration:none;cursor:pointer}
button:hover,a:hover{border-color:#d38b8b}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid #ff7777;outline-offset:3px}
button[aria-pressed=true]{background:#ede8e1;color:#151515}nav,.actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
label{display:block;margin:16px 0 8px}textarea{display:block;resize:vertical;width:100%;min-height:200px;background:#171717;border:1px solid #635a53;color:#f2eee8;padding:14px;font:15px/1.6 ui-monospace,monospace}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px;margin:20px 0}.cards a{display:grid;gap:6px}.cards small{color:#bdb8b2}
.surface{border-top:1px solid #514941;margin-top:16px;padding-top:12px}.metadata{font:11px/1.5 ui-monospace,monospace;overflow-wrap:anywhere;color:#a59c94}
[hidden]{display:none!important}@media(max-width:480px){body{padding:12px}h1{font-size:27px}button,a{min-height:44px}}
</style></head><body><main>
<aside class="qa">QA FIXTURE ONLY · Loopback UI test · No real agents, computers, messages or authentication provider.</aside>
<p class="metadata" id="document-id"></p><div id="page"></div>
</main><script>
(() => {
  'use strict';
  const resources = ${JSON.stringify(resources)};
  const ownerKey = 'ui-fixture-owner';
  const authStorageKey = 'hivra-ui-fixture:signed-in';
  const surfaces = [{ id: 'chat', label: 'Chat' }, { id: 'files', label: 'Files' }, { id: 'manage', label: 'Manage' }];
  const page = document.getElementById('page');
  let signedIn = location.pathname !== '/sign-in' && readAuth();
  let currentResource = null;
  let activeSurface = 'chat';
  document.getElementById('document-id').textContent = 'QA page instance: ' + Math.random().toString(36).slice(2, 10);
  function readAuth() { try { return localStorage.getItem(authStorageKey) !== 'false'; } catch { return true; } }
  function handler() {
    if (window !== window.top || window.__HIVRA_NATIVE_WORKSPACE__?.version !== 1) return null;
    const value = window.webkit?.messageHandlers?.hivraWorkspace;
    return typeof value?.postMessage === 'function' ? value : null;
  }
  function post(value) { try { handler()?.postMessage(value); } catch { /* Closed QA window. */ } }
  function surfacePath() { return location.pathname.startsWith('/dashboard') ? location.pathname : '/dashboard'; }
  function publishWorkspace() { post({ version: 1, kind: 'workspace', ownerKey: signedIn ? ownerKey : null, resources: signedIn ? resources : [], loading: false, errors: { hermes: null, hivra: null } }); }
  function publishSurfaces(clear) {
    const available = signedIn && currentResource && !clear;
    post({ version: 1, kind: 'surfaces', pathname: surfacePath(), active: available ? activeSurface : '', surfaces: available ? surfaces : [] });
  }
  function publish() { publishWorkspace(); publishSurfaces(false); }
  function element(tag, text, className) {
    const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
  }
  function button(label, action) { const node = element('button', label); node.type = 'button'; node.addEventListener('click', action); return node; }
  // Validate the exact local presentation routes accepted by the native shell.
  function route(value) {
    if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.includes(String.fromCharCode(92)) || value.includes('#')) return null;
    try {
      const rawPath = value.split('?')[0];
      if (!/^[/]dashboard(?:[/][a-zA-Z0-9_-]+)*[/]?$/.test(rawPath)) return null;
      const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return null;
      const keys = [...url.searchParams.keys()];
      if (!keys.length) return path;
      if (new Set(keys).size !== keys.length) return null;
      if (path === '/dashboard/launch') {
        const kind = url.searchParams.get('kind');
        return keys.length === 2 && keys.includes('kind') && keys.includes('start') && ['agent', 'computer'].includes(kind) && url.searchParams.get('start') === '1'
          ? path + '?kind=' + kind + '&start=1' : null;
      }
      const tab = url.searchParams.get('tab');
      return keys.length === 1 && keys[0] === 'tab' && /^[a-z][a-z0-9_-]{0,63}$/.test(tab || '') ? path + '?tab=' + tab : null;
    } catch { return null; }
  }
  function navigate(href) {
    const next = route(href);
    if (!signedIn || !next) return false;
    publishSurfaces(true);
    history.pushState(null, '', next); render(); publish();
    return true;
  }
  function selectSurface(id) {
    if (!signedIn || !currentResource || !surfaces.some(surface => surface.id === id)) return false;
    activeSurface = id;
    history.replaceState(null, '', location.pathname + '?tab=' + id);
    for (const panel of page.querySelectorAll('[data-surface]')) panel.hidden = panel.dataset.surface !== id;
    for (const control of page.querySelectorAll('[data-surface-button]')) control.setAttribute('aria-pressed', String(control.dataset.surfaceButton === id));
    publishSurfaces(false);
    return true;
  }
  function setSignedIn(value) {
    publishSurfaces(true);
    signedIn = value;
    try { localStorage.setItem(authStorageKey, String(value)); } catch { /* In-memory QA still works. */ }
    history.pushState(null, '', value ? '/dashboard' : '/sign-in');
    render(); publish();
  }
  function render() {
    const resource = signedIn ? resources.find(item => item.href === location.pathname) : null;
    if (resource && currentResource?.uid === resource.uid) {
      selectSurface(new URLSearchParams(location.search).get('tab') || 'chat');
      return;
    }
    currentResource = resource || null; page.replaceChildren();
    if (!signedIn) {
      page.append(element('h1', 'QA fixture sign-in'), element('p', 'This is a local UI simulation. It does not authenticate to Hivra or an external service.'), button('Sign in to fixture', () => setSignedIn(true)));
      return;
    }
    page.append(element('h1', resource ? resource.name : 'QA workspace fixture'));
    page.append(element('p', 'All resource names and statuses on this page are static QA data. Nothing here provisions, runs or contacts a computer.'));
    const actions = element('div', '', 'actions');
    actions.append(button('QA home', () => navigate('/dashboard')), button('Reload fixture page', () => location.reload()), button('Sign out of fixture', () => setSignedIn(false)));
    page.append(actions);
    if (!resource) {
      page.append(element('p', 'QA route: ' + location.pathname + location.search, 'metadata'));
      const cards = element('div', '', 'cards');
      for (const item of resources) {
        const link = element('a'); link.href = item.href;
        link.append(element('strong', item.name), element('small', 'QA ' + item.kind + ' · ' + item.status));
        link.addEventListener('click', event => { event.preventDefault(); navigate(item.href); });
        cards.append(link);
      }
      page.append(cards);
      return;
    }
    const nav = element('nav'); nav.setAttribute('aria-label', 'QA fixture surfaces');
    for (const surface of surfaces) { const control = button(surface.label, () => selectSurface(surface.id)); control.dataset.surfaceButton = surface.id; nav.append(control); }
    page.append(nav);
    for (const surface of surfaces) {
      const panel = element('section', '', 'surface'); panel.dataset.surface = surface.id;
      if (surface.id === 'chat') {
        const label = element('label', 'Unsent UI test note'); label.htmlFor = 'qa-unsent-note';
        const note = element('textarea'); note.id = 'qa-unsent-note'; note.placeholder = 'Unsent UI test note'; note.autocomplete = 'off';
        panel.append(label, note, element('p', 'This text exists only in this page. There is no Send button or storage. Reload clears it; switching retained native tabs should keep it.'));
      } else panel.append(element('h2', surface.label + ' — QA placeholder'), element('p', 'No files, runtime commands, management actions or network integrations are implemented in this fixture.'));
      page.append(panel);
    }
    const tab = new URLSearchParams(location.search).get('tab');
    selectSurface(surfaces.some(surface => surface.id === tab) ? tab : 'chat');
  }
  window.addEventListener('hivra:navigate', event => {
    if (!handler() || !signedIn || !route(event.detail?.href)) return;
    event.preventDefault(); navigate(event.detail.href);
  });
  window.addEventListener('hivra:refresh', event => { if (handler() && signedIn) { event.preventDefault(); publish(); } });
  window.addEventListener('hivra:select-surface', event => {
    if (!handler() || !signedIn || event.detail?.pathname !== location.pathname || !currentResource || !surfaces.some(surface => surface.id === event.detail?.id)) return;
    event.preventDefault(); selectSurface(event.detail.id);
  });
  window.addEventListener('popstate', () => { signedIn = location.pathname !== '/sign-in' && readAuth(); render(); publish(); });
  window.addEventListener('pageshow', publish);
  window.addEventListener('pagehide', () => publishSurfaces(true));
  window.addEventListener('storage', event => {
    if (event.key !== authStorageKey) return;
    signedIn = readAuth(); history.replaceState(null, '', signedIn ? '/dashboard' : '/sign-in'); render(); publish();
  });
  render(); publish();
})();
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('QA fixture is read-only.'); return; }
  const path = new URL(request.url ?? '/', 'http://127.0.0.1:' + port).pathname;
  if (path === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, fixture: 'hivra-native-workspace-ui', resourceCount: resources.length }));
    return;
  }
  if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (path !== '/' && path !== '/sign-in' && path !== '/dashboard' && !path.startsWith('/dashboard/')) { response.writeHead(404); response.end('No endpoint exists in this QA fixture.'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(request.method === 'HEAD' ? undefined : html);
});
server.on('error', error => { console.error('QA fixture server:', error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('QA fixture only: http://127.0.0.1:' + port + '/dashboard'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
