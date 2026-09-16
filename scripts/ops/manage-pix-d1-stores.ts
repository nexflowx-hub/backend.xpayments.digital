import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STORE_CODES = ['MYPETS-BRL', 'TWT-BRL'] as const;
const D1_PROVIDER = 'pix-d1-primary';
const LEGACY_PROVIDER = 'pix-primary';

const asRecord = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return {};
};

async function loadStore(storeCode: string) {
  const store = await prisma.store.findUnique({
    where: { storeCode },
    include: {
      gatewayVaults: {
        where: { isActive: true },
        select: { id: true, provider: true, credentials: true, isActive: true },
      },
    },
  });

  if (!store) throw new Error(`${storeCode} not found`);
  if (store.status !== 'active') throw new Error(`${storeCode} is not active`);
  if (String(store.currency).toUpperCase() !== 'BRL') {
    throw new Error(`${storeCode} is not BRL`);
  }

  return store;
}

function credentialSummary(credentials: unknown) {
  const value = asRecord(credentials);
  const apiKey = String(value.apiKey ?? value.api_key ?? '');
  const webhookSecret = String(value.webhookSecret ?? value.webhook_secret ?? '');
  return {
    apiKeyPresent: Boolean(apiKey),
    apiKeyPrefixOk: apiKey.startsWith('pk_'),
    webhookSecretPresent: Boolean(webhookSecret),
    webhookSecretPrefixOk: webhookSecret.startsWith('whsec_'),
    baseUrl: String(value.baseUrl ?? ''),
  };
}

async function status() {
  const rows = [];
  for (const storeCode of STORE_CODES) {
    const store = await loadStore(storeCode);
    const rules = asRecord(store.routingRules);
    rows.push({
      storeCode,
      status: store.status,
      currency: store.currency,
      pixRoute: rules.pix ?? null,
      vaults: store.gatewayVaults.map(vault => ({
        id: vault.id,
        provider: vault.provider,
        isActive: vault.isActive,
        ...(vault.provider === D1_PROVIDER
          ? { credentials: credentialSummary(vault.credentials) }
          : {}),
      })),
    });
  }
  console.log(JSON.stringify({ success: true, action: 'status', stores: rows }, null, 2));
}

async function switchRoute(provider: string) {
  const results = [];
  for (const storeCode of STORE_CODES) {
    const store = await loadStore(storeCode);
    const vault = store.gatewayVaults.find(v => v.provider === provider);
    if (!vault) throw new Error(`${storeCode}: active vault ${provider} not found`);

    if (provider === D1_PROVIDER) {
      const summary = credentialSummary(vault.credentials);
      if (!summary.apiKeyPrefixOk || !summary.webhookSecretPrefixOk) {
        throw new Error(`${storeCode}: D1 credentials invalid`);
      }
    }

    const previousRules = asRecord(store.routingRules);
    const nextRules = { ...previousRules, pix: provider };

    await prisma.store.update({
      where: { id: store.id },
      data: { routingRules: nextRules },
    });

    results.push({
      storeCode,
      previousPixRoute: previousRules.pix ?? null,
      currentPixRoute: provider,
    });
  }

  console.log(JSON.stringify({
    success: true,
    action: provider === D1_PROVIDER ? 'activate' : 'rollback',
    stores: results,
  }, null, 2));
}

async function main() {
  const action = String(process.env.PIX_D1_ACTION ?? 'status').trim().toLowerCase();
  if (action === 'status') return status();
  if (action === 'activate') return switchRoute(D1_PROVIDER);
  if (action === 'rollback') return switchRoute(LEGACY_PROVIDER);
  throw new Error(`Unsupported PIX_D1_ACTION=${action}`);
}

main()
  .catch(error => {
    console.error(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
