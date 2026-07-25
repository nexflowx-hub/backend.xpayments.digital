const {
  PrismaClient
} = require('@prisma/client');

const Stripe = require('stripe');

const prisma =
  new PrismaClient();

const normalize = value =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, '_');

const safeCredentials = value => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value;
};

const getSecretKey = credentials =>
  credentials.secretKey ??
  credentials.secret_key ??
  credentials.apiKey ??
  credentials.api_key ??
  null;

const identifyVault = vault => {
  const credentials =
    safeCredentials(
      vault.credentials
    );

  return [
    vault.provider,
    credentials.code,
    credentials.name,
    credentials.label,
    credentials.alias,
    credentials.accountCode,
    credentials.account_code,
    credentials.accountId,
    credentials.account_id
  ]
    .filter(Boolean)
    .map(normalize);
};

const isTargetVault = vault => {
  const identifiers =
    identifyVault(vault);

  return identifiers.some(value =>
    value.includes('STRIPE_GP') ||
    value.includes('STRIPE_MAC')
  );
};

const redactStripeAccount = value => {
  const text =
    String(value ?? '');

  if (!text) {
    return null;
  }

  if (text.length <= 12) {
    return `${text.slice(0, 5)}...`;
  }

  return (
    `${text.slice(0, 8)}` +
    `...${text.slice(-4)}`
  );
};

async function inspectStripeVault(
  vault
) {
  const credentials =
    safeCredentials(
      vault.credentials
    );

  const secretKey =
    getSecretKey(
      credentials
    );

  console.log(
    '\n----------------------------------------'
  );

  console.log(
    'STRIPE VAULT DIAGNOSTIC'
  );

  console.log(
    '----------------------------------------'
  );

  console.log({
    vaultId:
      vault.id,

    provider:
      vault.provider,

    merchantId:
      vault.merchantId,

    storeId:
      vault.storeId,

    identifiers:
      identifyVault(vault),

    keyMode:
      typeof secretKey === 'string'
        ? secretKey.startsWith(
            'sk_live_'
          )
          ? 'live'
          : secretKey.startsWith(
              'sk_test_'
            )
            ? 'test'
            : 'unknown'
        : 'missing',

    publicKeyConfigured:
      Boolean(
        credentials.publicKey ??
        credentials.public_key
      ),

    webhookSecretConfigured:
      Boolean(
        credentials.webhookSecret ??
        credentials.webhook_secret
      )
  });

  if (
    typeof secretKey !== 'string' ||
    !secretKey.startsWith('sk_')
  ) {
    console.log(
      '⚠️ Secret Key Stripe não reconhecida.'
    );

    return;
  }

  const stripe =
    new Stripe(secretKey);

  try {
    const account =
      await stripe.accounts.retrieve();

    console.log(
      '\nStripe account:'
    );

    console.log({
      id:
        redactStripeAccount(
          account.id
        ),

      country:
        account.country,

      defaultCurrency:
        account.default_currency,

      chargesEnabled:
        account.charges_enabled,

      payoutsEnabled:
        account.payouts_enabled,

      detailsSubmitted:
        account.details_submitted
    });
  } catch (error) {
    console.log(
      '❌ Erro ao consultar conta Stripe:',
      error.message
    );

    return;
  }

  try {
    const endpoints =
      await stripe
        .webhookEndpoints
        .list({
          limit: 100
        });

    console.log(
      '\nStripe webhook endpoints:'
    );

    if (
      endpoints.data.length === 0
    ) {
      console.log(
        'Nenhum endpoint configurado.'
      );
    }

    for (
      const endpoint of
      endpoints.data
    ) {
      console.log({
        id:
          redactStripeAccount(
            endpoint.id
          ),

        url:
          endpoint.url,

        status:
          endpoint.status,

        livemode:
          endpoint.livemode,

        enabledEvents:
          endpoint.enabled_events
      });
    }
  } catch (error) {
    console.log(
      '❌ Erro ao listar webhooks Stripe:',
      error.message
    );
  }
}

async function main() {
  const merchants =
    await prisma.merchant.findMany({
      orderBy: {
        createdAt: 'asc'
      }
    });

  const bwMerchants =
    merchants.filter(merchant => {
      const values = [
        merchant.name,
        merchant.company,
        merchant.email
      ]
        .filter(Boolean)
        .map(normalize);

      return values.some(value =>
        value.includes('BW')
      );
    });

  console.log(
    '\n========================================'
  );

  console.log(
    'MERCHANTS BW'
  );

  console.log(
    '========================================'
  );

  if (
    bwMerchants.length === 0
  ) {
    console.log(
      'Nenhum Merchant BW encontrado.'
    );

    console.log(
      '\nMerchants disponíveis:'
    );

    for (
      const merchant of
      merchants
    ) {
      console.log({
        id:
          merchant.id,

        name:
          merchant.name,

        company:
          merchant.company,

        email:
          merchant.email,

        status:
          merchant.status
      });
    }

    return;
  }

  for (
    const merchant of
    bwMerchants
  ) {
    console.log('\nMerchant:');

    console.log({
      id:
        merchant.id,

      name:
        merchant.name,

      company:
        merchant.company,

      email:
        merchant.email,

      status:
        merchant.status,

      kycStatus:
        merchant.kycStatus
    });

    const stores =
      await prisma.store.findMany({
        where: {
          merchantId:
            merchant.id
        },

        orderBy: {
          createdAt: 'asc'
        }
      });

    console.log('\nStores:');

    for (
      const store of
      stores
    ) {
      console.log({
        id:
          store.id,

        storeCode:
          store.storeCode,

        name:
          store.name,

        domain:
          store.domain,

        status:
          store.status,

        currency:
          store.currency,

        routingRules:
          store.routingRules
      });
    }

    const storeIds =
      stores.map(
        store => store.id
      );

    const apiKeys =
      storeIds.length > 0
        ? await prisma.apiKey.findMany({
            where: {
              storeId: {
                in: storeIds
              }
            },

            orderBy: {
              createdAt: 'asc'
            }
          })
        : [];

    console.log('\nAPI Keys:');

    for (
      const apiKey of
      apiKeys
    ) {
      console.log({
        id:
          apiKey.id,

        storeId:
          apiKey.storeId,

        name:
          apiKey.name,

        environment:
          apiKey.environment,

        scopes:
          apiKey.scopes,

        keyConfigured:
          Boolean(apiKey.key),

        createdAt:
          apiKey.createdAt
      });
    }

    const vaults =
      await prisma
        .gatewayVault
        .findMany({
          where: {
            merchantId:
              merchant.id
          },

          orderBy: {
            createdAt: 'asc'
          }
        });

    console.log('\nGateway Vaults:');

    for (
      const vault of
      vaults
    ) {
      const credentials =
        safeCredentials(
          vault.credentials
        );

      console.log({
        id:
          vault.id,

        provider:
          vault.provider,

        storeId:
          vault.storeId,

        isActive:
          vault.isActive,

        identifiers:
          identifyVault(vault),

        secretKeyConfigured:
          Boolean(
            getSecretKey(
              credentials
            )
          ),

        publicKeyConfigured:
          Boolean(
            credentials.publicKey ??
            credentials.public_key
          ),

        webhookSecretConfigured:
          Boolean(
            credentials.webhookSecret ??
            credentials.webhook_secret
          )
      });
    }

    const webhooks =
      storeIds.length > 0
        ? await prisma.webhook.findMany({
            where: {
              storeId: {
                in: storeIds
              }
            },

            orderBy: {
              createdAt: 'asc'
            }
          })
        : [];

    console.log(
      '\nMerchant outbound webhooks:'
    );

    for (
      const webhook of
      webhooks
    ) {
      console.log({
        id:
          webhook.id,

        storeId:
          webhook.storeId,

        url:
          webhook.url,

        events:
          webhook.events,

        status:
          webhook.status,

        secretConfigured:
          Boolean(
            webhook.secret
          )
      });
    }

    const targets =
      vaults.filter(
        isTargetVault
      );

    console.log(
      '\nTarget vault count:',
      targets.length
    );

    for (
      const vault of
      targets
    ) {
      await inspectStripeVault(
        vault
      );
    }
  }
}

main()
  .catch(error => {
    console.error(
      '\n❌ Inventory failed:',
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
