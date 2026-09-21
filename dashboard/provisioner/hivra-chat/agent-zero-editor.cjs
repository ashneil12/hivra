// Exact-source native editor lifecycle adapter.
// Targets the exact MIT-licensed v2.2 files captured from the pinned OCI image.
const { createHash } = require('node:crypto');

const SOURCES = Object.freeze({
  '/components/modals/file-editor/file-editor-store.js': '0b5c2f4a00bf9c5b7b8059ee6c9797a139470b06039d08b9a419c0c7d62be5bd',
  '/components/modals/file-editor/file-edit-modal.html': '897f2a7f036db3a0e039101dab24ece725dac8ca04c66ed5700822735fc74a84',
});

function rewriteNativeEditorAsset(assetPath, source) {
  if (!Object.hasOwn(SOURCES, assetPath)) return null;
  if (!Buffer.isBuffer(source) || createHash('sha256').update(source).digest('hex') !== SOURCES[assetPath]) {
    throw new Error('Agent Zero native editor source mismatch');
  }
  let text = source.toString('utf8');
  if (assetPath.endsWith('.html')) {
    text = text.replace(
      '<div id="file-editor-container" class="no-scrollbar"></div>',
      '<div id="file-editor-container" class="no-scrollbar" x-init="$nextTick(() => $store.fileEditor.initEditor($el))"></div>',
    );
  } else {
    // Every reset invalidates outstanding loads, saves, and modal callbacks.
    text = text.replace('  editor: null,', '  editor: null,\n  editGeneration: 0,');
    text = text.replace('  resetEditState() {', '  resetEditState() {\n    this.editGeneration++;');
    text = text.replaceAll('    this.resetEditState();', '    this.resetEditState();\n    const generation = this.editGeneration;');
    text = text.replaceAll('() => this.beforeCloseFileEditor()', '() => generation !== this.editGeneration || this.beforeCloseFileEditor()');
    text = text.replaceAll('this.editClosePromise.then(() => this.resetEditState());', 'this.editClosePromise.then(() => {\n        if (generation === this.editGeneration) this.resetEditState();\n      });');
    text = text.replace('  async saveFileEdits() {', '  async saveFileEdits() {\n    const generation = this.editGeneration;');
    text = text.replaceAll('      const data = await resp.json().catch(() => ({}));', '      const data = await resp.json().catch(() => ({}));\n      if (generation !== this.editGeneration) return;');
    text = text.replaceAll('    } catch (error) {', '    } catch (error) {\n      if (generation !== this.editGeneration) return;');
    text = text.replace('      // Reset isSaving before closing', '      if (generation !== this.editGeneration) return;\n\n      // Reset isSaving before closing');
    text = text.replace(/^ *this\.scheduleEditorInit\(\);\n/gm, '');
    const start = text.indexOf('  scheduleEditorInit() {');
    const end = text.indexOf('    if (!window.ace?.edit) {', start);
    text = text.slice(0, start) + [
      '  initEditor(container) {',
      '    // The modal owns initialization after Alpine mounts this exact node.',
      '    // Ignore stale nextTick callbacks and never reset an active editor.',
      '    if (!container?.isConnected || container !== document.getElementById("file-editor-container")) return;',
      '    if (this.isEditLoading || this.editError || this.editor) return;',
      '',
    ].join('\n') + text.slice(end);
    text = text.replace('window.ace.edit("file-editor-container")', 'window.ace.edit(container)');
  }
  return Buffer.from(text, 'utf8');
}

module.exports = { SOURCES, rewriteNativeEditorAsset };
