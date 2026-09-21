/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260915130000_windows_byo_iso_launch.sql"), "utf8");
const sourceSql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260915143000_windows_iso_source.sql"), "utf8");

it("persists the customer ISO attestation without any product-key field", () => {
  expect(sql).toContain("windows_rights_attested_by");
  expect(sql).toContain("windows_rights_attested_at");
  expect(sql).toContain("windows_rights_terms_version");
  expect(sql).toContain("windows_iso_modified_at_seconds");
  expect(sql).toContain("windows_iso_file_identity_sha256");
  expect(sql).not.toMatch(/add column[^;]*(product|activation)[_-]?key/i);
});

it("persists only bounded host-observed Windows media provenance", () => {
  expect(sourceSql).toContain("add column if not exists windows_iso_source text");
  expect(sourceSql).toContain("windows_iso_source is null");
  expect(sourceSql).toContain("'unknown', 'windows-11', 'windows-server-evaluation'");
});

it("serializes launch request IDs and binds replay to one agent", () => {
  expect(sql).toContain("primary key (user_id, request_id)");
  expect(sql).toContain("agent_id uuid not null unique");
  expect(sql).toContain("pg_advisory_xact_lock");
  expect(sql).toContain("if found and q.accepted_at is null then return jsonb_build_object('status', 'pending'");
  expect(sql).not.toContain("'agent', to_jsonb(a)");
  expect(sql).not.toContain("digest(");
  expect(sql).not.toContain("gen_random_bytes(");
  expect(sql).toContain(
    "replace(pg_catalog.gen_random_uuid()::text,'-','') || replace(pg_catalog.gen_random_uuid()::text,'-','')",
  );
});

it("restricts media evidence to the exact supported JSONB keys and value shapes", () => {
  expect(sql).not.toContain("jsonb_object_length(");
  expect(sql).toContain("media_evidence - array['sizeBytes','modifiedAtSeconds','fileIdentitySha256'] = '{}'::jsonb");
  expect(sql).toContain("media_evidence ?& array['sizeBytes','modifiedAtSeconds','fileIdentitySha256']");
  expect(sql).toContain("jsonb_typeof(media_evidence->'sizeBytes')='number'");
  expect(sql).toContain("media_evidence->>'sizeBytes' ~ '^[0-9]+$'");
  expect(sql).toContain("jsonb_typeof(media_evidence->'modifiedAtSeconds')='number'");
  expect(sql).toContain("media_evidence->>'modifiedAtSeconds' ~ '^[0-9]+$'");
  expect(sql).toContain("jsonb_typeof(media_evidence->'fileIdentitySha256')='string'");
  expect(sql).toContain("media_evidence->>'fileIdentitySha256' ~ '^[a-f0-9]{64}$'");
});

it("atomically accepts only the exact allocation and clears the complete operation shape", () => {
  expect(sql).toContain("a.allocation_operation_id=p_operation_id");
  expect(sql).toContain("operation_started_at=null,operation_payload=null");
  const operationShape = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260906190000_hivra_attachment_lease.sql"), "utf8");
  expect(operationShape).toContain("operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null");
});
