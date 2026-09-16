import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ALLOWED_STORES = new Set(['MYPETS-BRL', 'TWT-BRL']);
const onlyDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

function isValidCpf(value: unknown): boolean {
  const cpf = onlyDigits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  const digit = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(cpf[i]) * (length + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

async function main() {
  const storeCode = String(process.env.PIX_TEST_STORE_CODE ?? '').trim().toUpperCase();
  const payerName = String(process.env.PIX_TEST_PAYER_NAME ?? '').trim();
  const payerCpf = onlyDigits(process.env.PIX_TEST_PAYER_CPF);
  const confirmed = String(process.env.PIX_TEST_CONFIRM ?? '').trim() === 'YES';

  if (!ALLOWED_STORES.has(storeCode)) throw new Error('PIX_TEST_STORE_CODE must be MYPETS-BRL or TWT-BRL');
  if (!confirmed) throw new Error('Set PIX_TEST_CONFIRM=YES to create a real R$10 PIX.');
  if (payerName.length < 3) throw new Error('PIX_TEST_PAYER_NAME is required.');
  if (!isValidCpf(payerCpf)) throw new Error('PIX_TEST_PAYER_CPF must be a valid CPF.');

  const store = await prisma.store.findUnique({
    where: { storeCode },
    select: {
      id: true,
      status: true,
      currency: true,
      routingRules: true,
      apiKeys: {
        where: { environment: 'live' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { key: true, scopes: true },
      },
      gatewayVaults: {
        where: { isActive: true },
        select: { id: true, provider: true },
      },
    },
  });

  if (!store) throw new Error(`${storeCode} not found.`);
  if (store.status !== 'active') throw new Error(`${storeCode} is not active.`);
  if (String(store.currency).toUpperCase() !== 'BRL') throw new Error(`${storeCode} is not BRL.`);

  const rules = (store.routingRules ?? {}) as Record<string, unknown>;
  if (rules.pix !== 'pix-d1-primary') throw new Error(`${storeCode} PIX routing is ${String(rules.pix ?? '')}, expected pix-d1-primary.`);
  if (!store.gatewayVaults.some(v => v.provider === 'pix-d1-primary')) throw new Error(`${storeCode} active D1 vault not found.`);

  const apiKey = store.apiKeys[0];
  if (!apiKey?.key) throw new Error(`${storeCode} live API key not found.`);
  if (!apiKey.scopes.includes('payments_write')) throw new Error(`${storeCode} live API key lacks payments_write.`);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const reference = `${storeCode.replace(/[^A-Z0-9]/g, '').slice(0, 12)}-D1-${stamp}`;

  const response = await fetch('http://127.0.0.1:8084/api/v1/payments/charge', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount: 1000,
      currency: 'BRL',
      payment_method_types: ['pix'],
      reference,
      customer: {
        name: payerName,
        cpf: payerCpf,
        document: payerCpf,
        taxId: payerCpf,
      },
      metadata: {
        source: 'pix-d1-live-probe',
        description: storeCode === 'TWT-BRL' ? 'Apoio Together We Feed' : 'Teste MyPets',
      },
    }),
  });

  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }

  if (!response.ok || body?.success !== true) {
    console.error(JSON.stringify({ success: false, storeCode, httpStatus: response.status, reference, response: body }, null, 2));
    process.exitCode = 2;
    return;
  }

  const action = body?.action ?? {};
  const publicJson = JSON.stringify(body).toLowerCase();
  const providerExposed =
    publicJson.includes('pixgo') ||
    Boolean(body?.provider) ||
    Boolean(action?.provider) ||
    Boolean(action?.qrCodeUrl);

  console.log(JSON.stringify({
    success: true,
    storeCode,
    httpStatus: response.status,
    routing: 'pix-d1-primary',
    reference: body?.reference ?? reference,
    transactionId: body?.transactionId ?? null,
    status: body?.status ?? null,
    method: body?.method ?? null,
    expiresAt: action?.expiresAt ?? null,
    qrEmbedded: Boolean(action?.qrCodeBase64 || action?.qrCode),
    copyPastePresent: Boolean(action?.copyPaste || action?.pixString),
    providerExposed,
  }, null, 2));

  const copyPaste = action?.copyPaste ?? action?.pixString ?? '';
  if (copyPaste) {
    console.log('\nPIX COPIA E COLA:\n');
    console.log(copyPaste);
  }
}

main()
  .catch(error => {
    console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
