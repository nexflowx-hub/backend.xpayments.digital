import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const onlyDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

function isValidCpf(value: unknown): boolean {
  const cpf = onlyDigits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;

  const calc = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

async function main() {
  const payerName = String(process.env.TWT_PAYER_NAME ?? '').trim();
  const payerCpf = onlyDigits(process.env.TWT_PAYER_CPF);
  const confirmed = String(process.env.TWT_LIVE_CONFIRM ?? '').trim() === 'YES';

  if (!confirmed) {
    throw new Error('Set TWT_LIVE_CONFIRM=YES to create the real R$10 PIX probe.');
  }
  if (payerName.length < 3) {
    throw new Error('TWT_PAYER_NAME is required.');
  }
  if (!isValidCpf(payerCpf)) {
    throw new Error('TWT_PAYER_CPF must be a valid CPF.');
  }

  const store = await prisma.store.findUnique({
    where: { storeCode: 'TWT-BRL' },
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

  if (!store) throw new Error('TWT-BRL store not found.');
  if (store.status !== 'active') throw new Error(`TWT-BRL is not active: ${store.status}`);
  if (store.currency !== 'BRL') throw new Error(`TWT-BRL currency is not BRL: ${store.currency}`);

  const rules = (store.routingRules ?? {}) as Record<string, unknown>;
  if (rules.pix !== 'pix-d1-primary') {
    throw new Error(`TWT-BRL PIX routing is not pix-d1-primary: ${String(rules.pix ?? '')}`);
  }

  const vault = store.gatewayVaults.find((item) => item.provider === 'pix-d1-primary');
  if (!vault) throw new Error('Active pix-d1-primary vault not found for TWT-BRL.');

  const apiKey = store.apiKeys[0];
  if (!apiKey?.key) throw new Error('Live TWT-BRL API key not found.');
  if (!apiKey.scopes.includes('payments_write')) {
    throw new Error('TWT-BRL live API key does not include payments_write.');
  }

  const reference = `TWT-PIX-D1-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const payload = {
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
      source: 'twt-live-probe',
      donation_type: 'one_time',
      cause_id: 'together-we-feed',
      cause_slug: 'together-we-feed',
      cause_title: 'Together We Feed',
      cause_category: 'Proteção animal',
      support_target_type: 'campaign',
    },
  };

  const response = await fetch('http://127.0.0.1:8084/api/v1/payments/charge', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  if (!response.ok || body?.success !== true) {
    console.error(JSON.stringify({
      success: false,
      httpStatus: response.status,
      reference,
      response: body,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const action = body?.action ?? {};
  console.log(JSON.stringify({
    success: true,
    httpStatus: response.status,
    storeCode: 'TWT-BRL',
    routing: 'pix-d1-primary',
    reference: body?.reference ?? reference,
    transactionId: body?.transactionId ?? null,
    status: body?.status ?? null,
    method: body?.method ?? 'pix',
    expiresAt: action?.expiresAt ?? null,
    qrEmbedded: Boolean(action?.qrCodeBase64 || action?.qrCode),
    providerExposed: Boolean(body?.provider || action?.provider || action?.qrCodeUrl),
  }, null, 2));

  const copyPaste = action?.copyPaste ?? action?.pixString ?? '';
  if (copyPaste) {
    console.log('\nPIX COPIA E COLA:\n');
    console.log(copyPaste);
  } else {
    console.log('\nPIX copy/paste was not returned.');
  }
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
