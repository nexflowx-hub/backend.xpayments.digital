const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const XPAYMASTER_EMAIL =
  process.env.XPAYMASTER_EMAIL || 'master@xpayments.digital';

const XPAYMASTER_NAME =
  process.env.XPAYMASTER_NAME || 'XPayMaster';

const XPAYMASTER_COMPANY =
  process.env.XPAYMASTER_COMPANY || 'XPayments Digital';

const SOURCE_STORE_CODE =
  process.env.SOURCE_STORE_CODE || 'REVEUROPE';

const TARGET_STORE_CODE =
  process.env.TARGET_STORE_CODE || 'REVEURO2';

const TARGET_STORE_NAME =
  process.env.TARGET_STORE_NAME || 'RevEuro-2';

function generatePassword() {
  return `XpM-${crypto.randomBytes(12).toString('base64url')}!9`;
}

function generateApiKey(environment) {
  const prefix =
    environment === 'live'
      ? 'xp_live_'
      : 'xp_test_';

  return `${prefix}${crypto.randomBytes(24).toString('hex')}`;
}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

async function ensureXPayMaster() {
  const existingMerchant = await prisma.merchant.findUnique({
    where: {
      email: XPAYMASTER_EMAIL
    }
  });

  let merchant = existingMerchant;
  let temporaryPassword = null;

  if (!merchant) {
    temporaryPassword = generatePassword();

    const passwordHash = await bcrypt.hash(
      temporaryPassword,
      12
    );

    merchant = await prisma.merchant.create({
      data: {
        email: XPAYMASTER_EMAIL,
        name: XPAYMASTER_NAME,
        company: XPAYMASTER_COMPANY,
        tier: 'TIER_A_MASTER',
        status: 'active',
        kycStatus: 'approved',
        riskScore: 0,
        passwordHash
      }
    });
  }

  const wallet = await prisma.wallet.upsert({
    where: {
      merchantId_currency: {
        merchantId: merchant.id,
        currency: 'EUR'
      }
    },
    update: {
      label: 'XPayMaster EUR',
      type: 'fiat'
    },
    create: {
      merchantId: merchant.id,
      currency: 'EUR',
      label: 'XPayMaster EUR',
      type: 'fiat',
      balance: 0,
      available: 0,
      reserved: 0
    }
  });

  return {
    merchant,
    wallet,
    temporaryPassword,
    created: !existingMerchant
  };
}

async function cloneRevEuropeStore() {
  const sourceStore = await prisma.store.findUnique({
    where: {
      storeCode: SOURCE_STORE_CODE
    },
    include: {
      merchant: {
        select: {
          id: true,
          email: true,
          name: true,
          company: true
        }
      },
      gatewayVaults: true,
      webhooks: true
    }
  });

  if (!sourceStore) {
    throw new Error(
      `Store origem ${SOURCE_STORE_CODE} não encontrada.`
    );
  }

  let targetStore = await prisma.store.findUnique({
    where: {
      storeCode: TARGET_STORE_CODE
    }
  });

  let storeCreated = false;

  if (!targetStore) {
    targetStore = await prisma.store.create({
      data: {
        merchantId: sourceStore.merchantId,
        storeCode: TARGET_STORE_CODE,
        name: TARGET_STORE_NAME,
        domain: null,
        status: sourceStore.status,
        revenue: 0,
        currency: sourceStore.currency,
        routingRules: sourceStore.routingRules,
        logoUrl: sourceStore.logoUrl,
        theme: sourceStore.theme
      }
    });

    storeCreated = true;
  } else if (
    targetStore.merchantId !== sourceStore.merchantId
  ) {
    throw new Error(
      `${TARGET_STORE_CODE} já pertence a outro Merchant.`
    );
  }

  const existingVaults =
    await prisma.gatewayVault.findMany({
      where: {
        storeId: targetStore.id
      }
    });

  if (
    existingVaults.length === 0 &&
    sourceStore.gatewayVaults.length > 0
  ) {
    for (const sourceVault of sourceStore.gatewayVaults) {
      await prisma.gatewayVault.create({
        data: {
          merchantId: sourceStore.merchantId,
          storeId: targetStore.id,
          provider: sourceVault.provider,
          credentials: sourceVault.credentials,
          isActive: sourceVault.isActive
        }
      });
    }
  }

  const existingWebhooks = await prisma.webhook.findMany({
    where: {
      storeId: targetStore.id
    }
  });

  if (
    existingWebhooks.length === 0 &&
    sourceStore.webhooks.length > 0
  ) {
    for (const sourceWebhook of sourceStore.webhooks) {
      await prisma.webhook.create({
        data: {
          storeId: targetStore.id,
          url: sourceWebhook.url,
          events: sourceWebhook.events || [],
          status: sourceWebhook.status,
          secret: generateWebhookSecret(),
          successRate: 100
        }
      });
    }
  }

  const existingLiveKey = await prisma.apiKey.findFirst({
    where: {
      storeId: targetStore.id,
      environment: 'live'
    }
  });

  const existingTestKey = await prisma.apiKey.findFirst({
    where: {
      storeId: targetStore.id,
      environment: 'test'
    }
  });

  let liveKey = null;
  let testKey = null;

  if (!existingLiveKey) {
    liveKey = generateApiKey('live');

    await prisma.apiKey.create({
      data: {
        storeId: targetStore.id,
        name: 'API Key - RevEuro-2 Production',
        key: liveKey,
        scopes: ['payments_write'],
        environment: 'live'
      }
    });
  }

  if (!existingTestKey) {
    testKey = generateApiKey('test');

    await prisma.apiKey.create({
      data: {
        storeId: targetStore.id,
        name: 'API Key - RevEuro-2 Sandbox',
        key: testKey,
        scopes: ['payments_write'],
        environment: 'test'
      }
    });
  }

  const finalStore = await prisma.store.findUnique({
    where: {
      id: targetStore.id
    },
    include: {
      apiKeys: {
        select: {
          id: true,
          name: true,
          environment: true,
          scopes: true,
          createdAt: true
        },
        orderBy: {
          createdAt: 'asc'
        }
      },
      webhooks: {
        select: {
          id: true,
          url: true,
          events: true,
          status: true,
          createdAt: true
        }
      },
      gatewayVaults: {
        select: {
          id: true,
          provider: true,
          isActive: true
        }
      }
    }
  });

  return {
    sourceStore,
    targetStore: finalStore,
    storeCreated,
    liveKey,
    testKey
  };
}

async function main() {
  const xpayMaster = await ensureXPayMaster();
  const revEuro2 = await cloneRevEuropeStore();

  console.log('');
  console.log('==============================================');
  console.log('XPAYMASTER');
  console.log('==============================================');
  console.log({
    created: xpayMaster.created,
    merchantId: xpayMaster.merchant.id,
    email: xpayMaster.merchant.email,
    name: xpayMaster.merchant.name,
    company: xpayMaster.merchant.company,
    status: xpayMaster.merchant.status,
    walletId: xpayMaster.wallet.id,
    walletCurrency: xpayMaster.wallet.currency
  });

  if (xpayMaster.temporaryPassword) {
    console.log('');
    console.log(
      'PASSWORD TEMPORÁRIA XPAYMASTER:',
      xpayMaster.temporaryPassword
    );
    console.log(
      'Guardar agora. Esta password não será novamente mostrada.'
    );
  } else {
    console.log('');
    console.log(
      'XPayMaster já existia. A password não foi alterada.'
    );
  }

  console.log('');
  console.log('==============================================');
  console.log('REVEURO-2');
  console.log('==============================================');
  console.log({
    created: revEuro2.storeCreated,
    merchantId: revEuro2.targetStore.merchantId,
    storeId: revEuro2.targetStore.id,
    storeCode: revEuro2.targetStore.storeCode,
    name: revEuro2.targetStore.name,
    status: revEuro2.targetStore.status,
    currency: revEuro2.targetStore.currency,
    routingRules: revEuro2.targetStore.routingRules,
    gatewayVaults: revEuro2.targetStore.gatewayVaults,
    webhooks: revEuro2.targetStore.webhooks,
    apiKeys: revEuro2.targetStore.apiKeys
  });

  if (revEuro2.testKey) {
    console.log('');
    console.log(
      'REVEURO-2 SANDBOX API KEY:',
      revEuro2.testKey
    );
  } else {
    console.log('');
    console.log(
      'A Store já possuía uma API Key Sandbox.'
    );
  }

  if (revEuro2.liveKey) {
    console.log('');
    console.log(
      'REVEURO-2 PRODUCTION API KEY:',
      revEuro2.liveKey
    );
  } else {
    console.log('');
    console.log(
      'A Store já possuía uma API Key de Produção.'
    );
  }

  console.log('');
  console.log('==============================================');
  console.log('CONCLUÍDO');
  console.log('==============================================');
}

main()
  .catch(error => {
    console.error('');
    console.error('ERRO:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
