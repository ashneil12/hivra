import assert from 'node:assert/strict';
import test from 'node:test';
import { analyseMigration, stripBodies } from './prod-migration-risk.mjs';

const prod = {
  tables: [{ name: 'agents' }, { name: 'users' }],
  row_estimates: [{ name: 'agents', rows: 107 }],
  functions: [{ sig: 'touch()' }],
  prodOnlyTables: ['users'],
};

test('a new table with its own policies is additive', () => {
  const r = analyseMigration('m', 'create table if not exists public.fresh (id uuid primary key);\nalter table public.fresh enable row level security;', prod);
  assert.equal(r.verdict, 'ADDITIVE');
});

test('NOT NULL and validated constraints on a populated prod table are not safe as-is', () => {
  const r = analyseMigration('m', "alter table public.agents alter column mode set not null;\nalter table public.agents add constraint agents_mode_check check (mode in ('a'));", prod);
  assert.equal(r.verdict, 'NOT-AS-IS');
  assert.deepEqual(r.flags.map((f) => f.code), ['NOT_NULL_ON_PROD_TABLE', 'CONSTRAINT_ON_PROD_TABLE']);
});

test('NOT VALID constraints and function-body text do not trip top-level checks', () => {
  const sql = "alter table public.agents add constraint c check (x > 0) not valid;\ncreate or replace function public.f() returns void language plpgsql as $$ begin delete from agents; end $$;";
  const r = analyseMigration('m', sql, prod);
  assert.equal(r.flags.some((f) => f.code === 'CONSTRAINT_ON_PROD_TABLE' || f.code === 'DATA'), false);
});

test('flags prod-only table references, replaced prod functions and existing tables', () => {
  const sql = "create table if not exists public.agents (id uuid);\ncreate or replace function public.touch() returns trigger language plpgsql as $f$ begin return new; end $f$;\ninsert into public.users (id) values (1);";
  const codes = analyseMigration('m', sql, prod).flags.map((f) => f.code);
  assert.ok(codes.includes('CREATE_EXISTING_TABLE'));
  assert.ok(codes.includes('REPLACES_PROD_FUNCTION'));
  assert.ok(codes.includes('REFERENCES_PROD_ONLY_TABLE'));
  assert.ok(codes.includes('DATA'));
});

test('auth.users is not the prod-only public.users table', () => {
  const r = analyseMigration('m', 'create table public.x (user_id uuid references auth.users(id));', prod);
  assert.equal(r.flags.some((f) => f.code === 'REFERENCES_PROD_ONLY_TABLE'), false);
});

test('stripBodies hides dollar-quoted bodies', () => {
  assert.doesNotMatch(stripBodies('do $$ begin update t set a = 1; end $$;').text, /update/);
});
