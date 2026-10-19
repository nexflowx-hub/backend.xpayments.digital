import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const controller = readFileSync(
  resolve(process.cwd(), 'src/modules/auth/controllers/auth.controller.ts'),
  'utf8'
);
const routes = readFileSync(
  resolve(process.cwd(), 'src/modules/auth/routes/auth.routes.ts'),
  'utf8'
);

test('PagarPIX onboarding is exposed under a dedicated auth route', () => {
  assert.match(routes, /router\.post\('\/pagarpix\/register', ctrl\.registerPagarPix\)/);
});

test('PagarPIX onboarding provisions BRL-first resources without a provider', () => {
  assert.match(controller, /currency: 'BRL'/);
  assert.match(controller, /label: 'PagarPIX Conta BRL'/);
  assert.match(controller, /status: 'draft'/);
  assert.match(controller, /processingState: 'awaiting_activation'/);
  assert.doesNotMatch(controller, /registerPagarPix[\s\S]*gatewayVault\.create/);
});

test('existing ecosystem identity is reused instead of duplicated', () => {
  assert.match(controller, /code: 'ACCOUNT_EXISTS'/);
  assert.match(controller, /Entre no PagarPIX com as credenciais existentes/);
});
