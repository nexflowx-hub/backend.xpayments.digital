#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MERCHANT_EMAIL = 'socialprojet@xpayments.digital';
const STORE_CODE = 'HUMANIMPACT-XPAY-SANDBOX';
const STORE_ID = 'fa995cc2-87a8-4eb2-bbe5-b65cd9e25777';
const VAULT_ID = '25b7324f-9e32-4307-a669-4687954e59c9';
const API_KEY_ID = 'f9ec18f3-bc32-4f38-949d-ca63f9285e70';
const PROVIDER = 'stripe-humanimpact-xpay-sandbox';

const ROUTING_RULES = {
  card: PROVIDER,
  mb_way: PROVIDER,
  bizum: PROVIDER,
  multibanco: PROVIDER,
};

const THEME = JSON.stringify({
  mode: 'light',
  checkoutDisplayName: 'HumanImpact',
  primaryColor: '#111111',
  localeMode: 'auto',
  autoReturnSeconds: 3,
});

function stripeMode(secretKey) {
  const key = String(secretKey || '');
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return 'unknown';
}

async function main() {
  const merchant = await prisma.merchant.findUnique({
    where: { email: MERCHANT_EMAIL },
  });

  if (!merchant) throw new Error('HUMANIMPACT_MERCHANT_NOT_FOUND');
  if (merchant.status !== 'active') throw new Error('HUMANIMPACT_MERCHANT_NOT_ACTIVE');

  const store = await prisma.store.findUnique({ where: { id: STORE_ID } });
  if (!store || store.merchantId !== merchant.id || store.storeCode !== STORE_CODE) {
    throw new Error('HUMANIMPACT_STORE_BINDING_MISMATCH');
  }

  const vault = await prisma.gatewayVault.findUnique({ where: { id: VAULT_ID } });
  if (!vault || vault.merchantId !== merchant.id || vault.storeId !== store.id) {
    throw new Error('HUMANIMPACT_VAULT_BINDING_MISMATCH');
  }
  if (!vault.isActive || vault.provider !== PROVIDER) {
    throw new Error('HUMANIMPACT_VAULT_NOT_ACTIVE');
  }

  const credentials = vault.credentials || {};
  if (stripeMode(credentials.secretKey) !== 'test') {
    throw new Error('HUMANIMPACT_VAULT_NOT_TEST_MODE');
  }
  if (String(credentials.environment || '').toLowerCase() !== 'test') {
    throw new Error('HUMANIMPACT_VAULT_ENVIRONMENT_MISMATCH');
  }
  if (String(credentials.processingMode || '').toUpperCase() !== 'ORCHESTRATED') {
    throw new Error('HUMANIMPACT_VAULT_NOT_ORCHESTRATED');
  }
  if (!String(credentials.webhookSecret || '').trim()) {
    throw new Error('HUMANIMPACT_WEBHOOK_SECRET_MISSING');
  }

  const apiKey = await prisma.apiKey.findUnique({ where: { id: API_KEY_ID } });
  if (!apiKey || apiKey.storeId !== store.id) {
    throw new Error('HUMANIMPACT_API_KEY_BINDING_MISMATCH');
  }
  if (apiKey.environment !== 'test' || !apiKey.scopes.includes('payments_write')) {
    throw new Error('HUMANIMPACT_API_KEY_NOT_PAYMENT_TEST');
  }

  await prisma.$transaction(async (tx) => {
    await tx.store.update({
      where: { id: store.id },
      data: {
        name: 'XPay Test - HumanImpact',
        status: 'active',
        currency: 'EUR',
        routingRules: ROUTING_RULES,
        theme: THEME,
      },
    });

    await tx.wallet.upsert({
      where: {
        merchantId_currency: {
          merchantId: merchant.id,
          currency: 'EUR',
        },
      },
      create: {
        merchantId: merchant.id,
        currency: 'EUR',
        label: 'HumanImpact EUR',
        balance: 0,
        available: 0,
        reserved: 0,
        type: 'fiat',
      },
      update: {
        label: 'HumanImpact EUR',
      },
    });
  });

  const verifiedStore = await prisma.store.findUnique({ where: { id: store.id } });
  const wallet = await prisma.wallet.findUnique({
    where: {
      merchantId_currency: {
        merchantId: merchant.id,
        currency: 'EUR',
      },
    },
  });

  console.log(JSON.stringify({
    success: true,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
    },
    store: {
      id: verifiedStore.id,
      storeCode: verifiedStore.storeCode,
      name: verifiedStore.name,
      status: verifiedStore.status,
      currency: verifiedStore.currency,
      routingRules: verifiedStore.routingRules,
      theme: verifiedStore.theme,
    },
    vault: {
      id: vault.id,
      provider: vault.provider,
      active: vault.isActive,
      environment: credentials.environment,
      processingMode: credentials.processingMode,
      secretPresent: Boolean(credentials.secretKey),
      webhookSecretPresent: Boolean(credentials.webhookSecret),
    },
    apiKey: {
      id: apiKey.id,
      name: apiKey.name,
      environment: apiKey.environment,
      scopes: apiKey.scopes,
      keyPreview: `${apiKey.key.slice(0, 12)}••••${apiKey.key.slice(-4)}`,
    },
    wallet: {
      id: wallet.id,
      currency: wallet.currency,
      label: wallet.label,
      balance: Number(wallet.balance),
      available: Number(wallet.available),
      reserved: Number(wallet.reserved),
    },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('HUMANIMPACT_SANDBOX_CONFIG_ERROR=' + (error?.message || String(error)));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
