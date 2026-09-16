import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'migrations/manual/20260916_pagarpix_functional_v3_core.sql'),
  'utf8'
);

test('wallet operations require merchant-scoped idempotency', () => {
  assert.match(
    migration,
    /UNIQUE \(merchant_id, idempotency_key\)/,
    'wallet_operations must enforce merchant-scoped idempotency'
  );
  assert.match(migration, /request_hash text NOT NULL/);
});

test('wallet operation shape prevents ambiguous source and destination semantics', () => {
  assert.match(migration, /type = 'deposit' AND destination_treasury_wallet_id IS NOT NULL/);
  assert.match(migration, /type = 'withdrawal' AND source_treasury_wallet_id IS NOT NULL/);
  assert.match(migration, /source_treasury_wallet_id <> destination_treasury_wallet_id/);
});

test('routing decisions are sticky, merchant scoped and shadow-first', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.routing_decisions/);
  assert.match(migration, /routing_decisions_idempotency_uq UNIQUE \(merchant_id, idempotency_key\)/);
  assert.match(migration, /activation_mode text NOT NULL DEFAULT 'shadow'/);
  assert.match(migration, /CHECK \(activation_mode IN \('shadow','enforce'\)\)/);
});

test('new financial control-plane tables are not exposed through Supabase client roles', () => {
  for (const table of [
    'wallet_operations',
    'wallet_operation_events',
    'routing_policies',
    'provider_health_snapshots',
    'routing_decisions'
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`REVOKE ALL ON public\\.${table} FROM anon, authenticated`));
  }
});
