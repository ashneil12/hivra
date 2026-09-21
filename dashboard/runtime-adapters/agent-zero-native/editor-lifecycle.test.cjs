const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { SOURCES, rewriteNativeEditorAsset } = require('../../provisioner/hivra-chat/agent-zero-editor.cjs');

const storePath = '/components/modals/file-editor/file-editor-store.js';
const modalPath = '/components/modals/file-editor/file-edit-modal.html';
const originalStore = fs.readFileSync(path.join(__dirname, 'fixtures/file-editor-store.js'));
const originalModal = fs.readFileSync(path.join(__dirname, 'fixtures/file-edit-modal.html'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = content => ({ ok: true, json: async () => ({ data: { content } }) });

// Load the actual pinned native model, retaining its method bodies. This is a
// local unit harness, not browser acceptance or a security sandbox.
function harness(source, { existing = false, fetchApi } = {}) {
  const frames = [];
  const created = [];
  let container = null;
  const modals = [];
  const document = { getElementById: () => container };
  const window = {
    openModal: (_path, beforeClose) => new Promise(resolve => { modals.push({ resolve, beforeClose }); }),
    closeModal: () => { container = null; modals.at(-1)?.resolve(); },
    requestAnimationFrame: callback => frames.push(callback),
    toastFrontendError: () => {},
    localStorage: { getItem: () => 'true' },
    ace: { edit: target => {
      const editor = { target, value: '', destroyed: false,
        destroy() { this.destroyed = true; },
        setTheme() {}, session: { setMode() {} },
        setValue(value) { this.value = value; },
        getValue() { return this.value; }, clearSelection() {},
      };
      created.push(editor);
      return editor;
    } },
  };
  const text = source.toString('utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export const store = createStore("fileEditor", model);', 'globalThis.store = createStore("fileEditor", model);');
  const context = { window, document, console: { warn() {}, error() {} },
    createStore: (_name, model) => model,
    fetchApi: fetchApi || (async () => ({ ok: true, json: async () => ({ data: { content: 'existing content', name: 'proof.txt' } }) })),
    confirm: () => false,
  };
  vm.runInNewContext(text, context, { timeout: 1000 });
  const store = context.store;
  return {
    store, created, frames, window, modals,
    open: () => existing ? store.openFile({ name: 'proof.txt', path: '/a0/usr/proof.txt' }) : store.openNewFile('/a0/usr', []),
    drainFrames() { for (let count = 0; frames.length && count < 20; count++) frames.shift()(); },
    mount() { container = { isConnected: true }; return container; },
    unmount() { if (container) container.isConnected = false; container = null; },
    close: () => window.closeModal(),
  };
}

test('original pinned model loses initialization when modal mounting takes more than two frames', async () => {
  const h = harness(originalStore);
  await h.open();
  h.drainFrames();
  h.mount();
  h.drainFrames();
  assert.equal(h.created.length, 0);
  assert.equal(h.store.editError, null);
});

test('native modal initializes its editor from the actual mounted element', () => {
  const html = rewriteNativeEditorAsset(modalPath, originalModal).toString('utf8');
  assert.match(html, /id="file-editor-container"[^>]*x-init="\$nextTick\(\(\) => \$store\.fileEditor\.initEditor\(\$el\)\)"/);
});

for (const existing of [false, true]) {
  test(`delayed mount initializes exactly once without a timer (existing=${existing})`, async () => {
    const h = harness(rewriteNativeEditorAsset(storePath, originalStore), { existing });
    await h.open();
    assert.equal(h.frames.length, 0, 'opening must not race a fixed animation-frame budget');
    const node = h.mount();
    h.store.initEditor(node);
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].target, node);
    assert.equal(h.created[0].value, existing ? 'existing content' : '');
    h.created[0].value = 'typed after mount';
    h.store.initEditor(node);
    assert.equal(h.created.length, 1, 'a duplicate mount callback must not replace an active editor');
    assert.equal(h.created[0].value, 'typed after mount');
  });
}

test('a callback for a closed or superseded modal cannot initialize the next editor', async () => {
  const h = harness(rewriteNativeEditorAsset(storePath, originalStore));
  await h.open();
  const oldNode = h.mount();
  h.unmount();
  h.store.initEditor(oldNode);
  assert.equal(h.created.length, 0);
  const newNode = h.mount();
  h.store.initEditor(oldNode);
  assert.equal(h.created.length, 0);
  h.store.initEditor(newNode);
  assert.equal(h.created.length, 1);
});

test('only the two exact native sources are eligible; drift and repeated rewriting fail closed', () => {
  for (const [name, source] of [[storePath, originalStore], [modalPath, originalModal]]) {
    assert.equal(createHash('sha256').update(source).digest('hex'), SOURCES[name]);
    assert.throws(() => rewriteNativeEditorAsset(name, Buffer.concat([source, Buffer.from('\n')])), /source mismatch/);
    assert.throws(() => rewriteNativeEditorAsset(name, rewriteNativeEditorAsset(name, source)), /source mismatch/);
    assert.throws(() => rewriteNativeEditorAsset(name, source.toString()), /source mismatch/);
  }
  assert.equal(rewriteNativeEditorAsset('/api/model', originalStore), null);
  assert.equal(rewriteNativeEditorAsset('/components/modals/file-editor/other.js', originalStore), null);
  assert.equal(rewriteNativeEditorAsset(`${storePath}?v=2`, originalStore), null);
  assert.equal(rewriteNativeEditorAsset('__proto__', originalStore), null);
});

test('loading, an existing error, and missing ACE preserve the native failure semantics', async () => {
  const h = harness(rewriteNativeEditorAsset(storePath, originalStore));
  await h.open();
  const node = h.mount();
  h.store.isEditLoading = true;
  h.store.initEditor(node);
  assert.equal(h.created.length, 0);
  h.store.isEditLoading = false;
  h.store.editError = 'Failed to load file';
  h.store.initEditor(node);
  assert.equal(h.created.length, 0);
  h.store.editError = null;
  h.window.ace = undefined;
  h.store.initEditor(node);
  assert.equal(h.store.editError, 'Editor library not loaded');
  assert.equal(h.created.length, 0);
});

test('closing destroys the old editor and a later open gets its own instance', async () => {
  const h = harness(rewriteNativeEditorAsset(storePath, originalStore));
  await h.open();
  const oldNode = h.mount();
  h.store.initEditor(oldNode);
  const oldEditor = h.created[0];
  h.close();
  await Promise.resolve();
  assert.equal(oldEditor.destroyed, true);
  assert.equal(h.store.editor, null);
  await h.open();
  const node = h.mount();
  h.store.initEditor(oldNode);
  assert.equal(h.created.length, 1);
  h.store.initEditor(node);
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].target, node);
});

for (const order of ['A-first', 'B-first', 'A-error']) {
  test(`closed file responses cannot bind another file's displayed content or save target (${order})`, async () => {
    const a = deferred(), b = deferred();
    const writes = [];
    const h = harness(rewriteNativeEditorAsset(storePath, originalStore), {
      fetchApi: (url, options) => {
        if (options?.method === 'POST') {
          writes.push(JSON.parse(options.body));
          return Promise.resolve(response(''));
        }
        return url.endsWith('%2FA.txt') ? a.promise : b.promise;
      },
    });
    const openingA = h.store.openFile({ name: 'A.txt', path: '/A.txt' });
    h.close();
    await Promise.resolve();
    const openingB = h.store.openFile({ name: 'B.txt', path: '/B.txt' });
    if (order === 'A-first') {
      a.resolve(response('A body'));
      await openingA;
      assert.equal(h.store.isEditLoading, true, 'stale A must not mount B prematurely');
      assert.equal(h.store.editContent, '');
    }
    b.resolve(response('B body'));
    await openingB;
    h.store.initEditor(h.mount());
    if (order === 'B-first') a.resolve(response('A body'));
    if (order === 'A-error') a.reject(new Error('old failure'));
    await openingA;
    assert.equal(h.store.editTarget.path, '/B.txt');
    assert.equal(h.store.editError, null);
    assert.equal(h.store.editor.getValue(), 'B body');
    assert.equal(h.created.length, 1);
    await h.store.saveFileEdits();
    assert.deepEqual(writes, [{ path: '/B.txt', content: 'B body' }]);
  });
}

test('superseded modal close callbacks cannot inspect or destroy a new draft', async () => {
  const h = harness(rewriteNativeEditorAsset(storePath, originalStore));
  await h.open();
  const old = h.modals[0];
  await h.open();
  h.store.initEditor(h.mount());
  h.store.editor.value = 'new draft';
  assert.equal(old.beforeClose(), true, 'stale modal does not prompt about new draft');
  assert.equal(h.modals[1].beforeClose(), false, 'current draft still needs confirmation');
  old.resolve();
  await Promise.resolve();
  assert.equal(h.store.editor.getValue(), 'new draft');
});

for (const outcome of ['success', 'error', 'callback']) {
  test(`superseded save ${outcome} cannot reset, close, or report errors on a new editor`, async () => {
    const saved = deferred(), callback = deferred();
    let callbackCalls = 0;
    const h = harness(rewriteNativeEditorAsset(storePath, originalStore), { fetchApi: () => saved.promise });
    await h.store.openNewFile('/old', [], () => { callbackCalls++; return callback.promise; });
    h.store.editFileName = 'old.txt';
    const saving = h.store.saveFileEdits();
    if (outcome === 'callback') {
      saved.resolve(response(''));
      // Let the actual save method enter its asynchronous success callback.
      for (let n = 0; n < 8 && !callbackCalls; n++) await Promise.resolve();
      assert.equal(callbackCalls, 1);
    }
    await h.store.openNewFile('/new', []);
    h.store.initEditor(h.mount());
    h.store.editor.value = 'new draft';
    if (outcome === 'error') saved.reject(new Error('old save failure'));
    else if (outcome === 'success') saved.resolve(response(''));
    else callback.resolve();
    await saving;
    assert.equal(callbackCalls, outcome === 'callback' ? 1 : 0);
    assert.equal(h.store.editor.getValue(), 'new draft');
    assert.equal(h.store.editSaveError, null);
    assert.equal(h.store.editIsNew, true);
    assert.equal(h.store.isSaving, false);
  });
}
