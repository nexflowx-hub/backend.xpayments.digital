import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STORE_CODE = 'MYPETS-BRL';
const PROVIDER_ALIAS = 'pix-d1-primary';
const LEGACY_PROVIDER_ALIAS = 'pix-primary';
const BASE_URL = 'https://pixgo.org/api/v1';

const parseRules = (value: unknown): Record<string, any> => {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, any>;
    }
  } catch {
    // handled below
  }
  return {};
};

const probeApiKey = async (apiKey: string) => {
  const response = await fetch(
    `${BASE_URL}/payment/00000000-0000-0000-0000-000000000000`,
    {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(10000)
    }
  );

  const body: any = await response.json().catch(() => ({}));
  if (response.status !== 404 || body?.error !== 'PAYMENT_NOT_FOUND') {
    throw new Error(
      `PIX D1 API credential probe failed: HTTP ${response.status}, code=${body?.error ?? 'unknown'}`
    );
  }
};

const main = async () => {
  const action = String(process.env.PIX_D1_ACTION ?? 'configure')
    .trim()
    .toLowerCase();

  const store = await prisma.store.findUnique({
    where: { storeCode: STORE_CODE }
  });

  if (!store) throw new Error(`${STORE_CODE} not found`);
  if (store.status !== 'active') throw new Error(`${STORE_CODE} is not active`);
  if (String(store.currency).toUpperCase() !== 'BRL') {
    throw new Error(`${STORE_CODE} must use BRL`);
  }

  const previousRules = parseRules(store.routingRules);

  if (action === 'configure') {
    const apiKey = String(process.env.PIX_D1_API_KEY ?? '').trim();
    const webhookSecret = String(process.env.PIX_D1_WEBHOOK_SECRET ?? '').trim();

    if (!apiKey.startsWith('pk_')) {
      throw new Error('PIX_D1_API_KEY missing or invalid');
    }
    if (!webhookSecret.startsWith('whsec_')) {
      throw new Error('PIX_D1_WEBHOOK_SECRET missing or invalid');
    }

    await probeApiKey(apiKey);

    const credentials = {
      apiKey,
      webhookSecret,
      baseUrl: BASE_URL,
      environment: 'live',
      configurationStatus: 'active'
    };

    const existing = await prisma.gatewayVault.findFirst({
      where: {
        merchantId: store.merchantId,
        storeId: store.id,
        provider: PROVIDER_ALIAS
      }
    });

    const vault = existing
      ? await prisma.gatewayVault.update({
          where: { id: existing.id },
          data: { credentials, isActive: true }
        })
      : await prisma.gatewayVault.create({
          data: {
            merchantId: store.merchantId,
            storeId: store.id,
            provider: PROVIDER_ALIAS,
            credentials,
            isActive: true
          }
        });

    console.log(JSON.stringify({
      success: true,
      action: 'configure',
      storeCode: STORE_CODE,
      storeId: store.id,
      vaultId: vault.id,
      providerAlias: PROVIDER_ALIAS,
      routingChanged: false,
      currentPixRoute: previousRules.pix ?? null,
      credentialProbe: 'PASS'
    }, null, 2));
    return;
  }

  if (action === 'activate') {
    const vault = await prisma.gatewayVault.findFirst({
      where: {
        merchantId: store.merchantId,
        storeId: store.id,
        provider: PROVIDER_ALIAS,
        isActive: true
      }
    });
    if (!vault) throw new Error('PIX D1 vault is not configured/active');

    const nextRules = { ...previousRules, pix: PROVIDER_ALIAS };
    await prisma.store.update({
      where: { id: store.id },
      data: { routingRules: nextRules }
    });

    console.log(JSON.stringify({
      success: true,
      action: 'activate',
      storeCode: STORE_CODE,
      previousPixRoute: previousRules.pix ?? null,
      currentPixRoute: PROVIDER_ALIAS
    }, null, 2));
    return;
  }

  if (action === 'rollback') {
    const legacyVault = await prisma.gatewayVault.findFirst({
      where: {
        merchantId: store.merchantId,
        storeId: store.id,
        provider: LEGACY_PROVIDER_ALIAS,
        isActive: true
      }
    });
    if (!legacyVault) throw new Error('Legacy PIX vault is not active');

    const nextRules = { ...previousRules, pix: LEGACY_PROVIDER_ALIAS };
    await prisma.store.update({
      where: { id: store.id },
      data: { routingRules: nextRules }
    });

    console.log(JSON.stringify({
      success: true,
      action: 'rollback',
      storeCode: STORE_CODE,
      previousPixRoute: previousRules.pix ?? null,
      currentPixRoute: LEGACY_PROVIDER_ALIAS
    }, null, 2));
    return;
  }

  throw new Error(`Unsupported PIX_D1_ACTION=${action}`);
};

main()
  .catch(error => {
    console.error('[PIX-D1 CONFIG ERROR]', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
