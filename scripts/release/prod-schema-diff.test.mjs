import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSnapshots, renderMarkdown } from './prod-schema-diff.mjs';

const fn = (sig, extra = {}) => ({ sig, h: 'x', secdef: false, config: '', anon_exec: false, auth_exec: false, service_exec: true, is_trigger: false, ...extra });

test('separates table-level drift from objects implied by one-sided tables', () => {
  const canary = {
    tables: [{ name: 'shared', rls: true, force_rls: false }, { name: 'new_table', rls: true, force_rls: false }],
    columns: [{ t: 'shared', c: 'id', type: 'uuid', not_null: true }, { t: 'shared', c: 'added', type: 'text', not_null: false },
      { t: 'new_table', c: 'id', type: 'uuid', not_null: true }],
    functions: [fn('f()', { h: 'new' })],
  };
  const prod = {
    tables: [{ name: 'shared', rls: true, force_rls: false }, { name: 'legacy', rls: false, force_rls: false }],
    columns: [{ t: 'shared', c: 'id', type: 'uuid', not_null: true }, { t: 'legacy', c: 'id', type: 'int', not_null: true }],
    functions: [fn('f()', { h: 'old' }), fn('open(uuid)', { secdef: true, anon_exec: true })],
  };
  const d = diffSnapshots(canary, prod);
  assert.deepEqual(d.tables.onlyA, ['new_table']);
  assert.deepEqual(d.tables.onlyB, ['legacy']);
  assert.deepEqual(d.columns.onlyA, ['shared.added']);
  assert.equal(d.columns.impliedByTableA, 1);
  assert.equal(d.columns.impliedByTableB, 1);
  assert.deepEqual(d.functions.changed.map((c) => c.key), ['f()']);
  assert.deepEqual(d.risks.exposedDefinerB, ['open(uuid)']);
  assert.deepEqual(d.risks.rlsOffB, ['legacy']);
  assert.match(renderMarkdown(d), /\| tables \| 2 \| 2 \| 1 \| 1 \| 0 \|/);
});

test('trigger functions are not reported as callable definers', () => {
  const d = diffSnapshots({ functions: [] }, { functions: [fn('guard()', { secdef: true, anon_exec: true, is_trigger: true })] });
  assert.deepEqual(d.risks.exposedDefinerB, []);
});
