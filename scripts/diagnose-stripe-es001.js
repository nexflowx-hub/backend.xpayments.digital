const { PrismaClient } = require('@prisma/client');
const Stripe = require('stripe');

const prisma = new PrismaClient();

const EXPECTED_WEBHOOK_URL =
  'https://api.xpayments.digital/api/v1/payments/webhooks/stripe';

const redactId = value => {
  if (!value) return null;

  const text = String(value);

  if (text.length <= 10) {
    return `${text.slice(0, 4)}...`;
  }

  return `${text.slice(0, 8)}...${text.slice(-4)}`;
};

const normalize = value =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/-/g, '_');

async function main() {
  const vaults =
    await prisma.gatewayVault.findMany({
      where: {
        isActive: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

  const matches = vaults.filter(vault => {
    const credentials =
      vault.credentials &&
      typeof vault.credentials === 'object' &&
      !Array.isArray(vault.credentials)
        ? vault.credentials
        : {};

    const candidates = [
      vault.provider,
      credentials.accountId,
      credentials.accountCode,
      credentials.name,
      credentials.code,
      credentials.label
    ];

    return candidates.some(
      value =>
        normalize(value) === 'STRIPE_ES001' ||
        normalize(value).includes('STRIPE_ES001') ||
        normalize(value).includes('STRIPE_ES')
    );
  });

  if (matches.length === 0) {
    console.error(
      '❌ Nenhum GatewayVault STRIPE_ES001 encontrado.'
    );

    console.log(
      '\nGateways Stripe ativos encontrados:'
    );

    for (const vault of vaults) {
      if (
        String(vault.provider)
          .toLowerCase()
          .includes('stripe')
      ) {
        const credentials =
          vault.credentials &&
          typeof vault.credentials === 'object' &&
          !Array.isArray(vault.credentials)
            ? vault.credentials
            : {};

        console.log({
          vaultId: vault.id,
          provider: vault.provider,
          merchantId: vault.merchantId,
          storeId: vault.storeId,
          accountId:
            credentials.accountId ?? null
        });
      }
    }

    process.exitCode = 1;
    return;
  }

  for (const vault of matches) {
    const credentials =
      vault.credentials &&
      typeof vault.credentials === 'object' &&
      !Array.isArray(vault.credentials)
        ? vault.credentials
        : {};

    const secretKey =
      credentials.secretKey;

    console.log('\n========================================');
    console.log('GATEWAY VAULT');
    console.log('========================================');

    console.log({
      vaultId: vault.id,
      provider: vault.provider,
      merchantId: vault.merchantId,
      storeId: vault.storeId,
      isActive: vault.isActive,

      configuredAccountId:
        credentials.accountId ?? null,

      keyMode:
        typeof secretKey === 'string'
          ? secretKey.startsWith('sk_live_')
            ? 'live'
            : secretKey.startsWith('sk_test_')
              ? 'test'
              : 'unknown'
          : 'missing',

      publicKeyConfigured:
        typeof credentials.publicKey === 'string',

      webhookSecretConfigured:
        typeof credentials.webhookSecret === 'string',

      webhookSecretPrefix:
        typeof credentials.webhookSecret === 'string'
          ? `${credentials.webhookSecret.slice(0, 6)}...`
          : null
    });

    if (
      typeof secretKey !== 'string' ||
      !secretKey.startsWith('sk_')
    ) {
      console.error(
        '❌ secretKey Stripe ausente ou inválida no GatewayVault.'
      );

      continue;
    }

    const stripe =
      new Stripe(secretKey);

    try {
      const account =
        await stripe.accounts.retrieve();

      console.log('\nCONTA STRIPE DA SECRET KEY');

      console.log({
        stripeAccountId: account.id,
        country: account.country,
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
      console.error(
        '❌ Não foi possível consultar a conta Stripe:',
        error.message
      );

      continue;
    }

    try {
      const endpoints =
        await stripe.webhookEndpoints.list({
          limit: 100
        });

      console.log('\nWEBHOOK ENDPOINTS DA CONTA');

      if (endpoints.data.length === 0) {
        console.log(
          '❌ Nenhum webhook endpoint configurado nesta conta/modo.'
        );
      }

      for (
        const endpoint of
        endpoints.data
      ) {
        const events =
          endpoint.enabled_events ?? [];

        const receivesRequiredEvents =
          events.includes('*') ||
          (
            events.includes(
              'payment_intent.succeeded'
            ) &&
            events.includes(
              'payment_intent.payment_failed'
            )
          );

        console.log({
          endpointId:
            redactId(endpoint.id),

          url:
            endpoint.url,

          status:
            endpoint.status,

          livemode:
            endpoint.livemode,

          apiVersion:
            endpoint.api_version,

          enabledEvents:
            events,

          matchesExpectedUrl:
            endpoint.url ===
            EXPECTED_WEBHOOK_URL,

          receivesRequiredEvents
        });
      }

      const exactEndpoint =
        endpoints.data.find(
          endpoint =>
            endpoint.url ===
            EXPECTED_WEBHOOK_URL
        );

      if (!exactEndpoint) {
        console.log(
          '\n❌ A conta STRIPE_ES001 não possui o endpoint esperado:'
        );

        console.log(
          EXPECTED_WEBHOOK_URL
        );
      } else {
        console.log(
          '\n✅ Endpoint esperado encontrado na conta.'
        );
      }
    } catch (error) {
      console.error(
        '❌ Erro ao listar endpoints Stripe:',
        error.message
      );
    }

    try {
      const events =
        await stripe.events.list({
          limit: 20
        });

      console.log('\nEVENTOS STRIPE RECENTES');

      for (const event of events.data) {
        console.log({
          id:
            redactId(event.id),

          type:
            event.type,

          livemode:
            event.livemode,

          created:
            new Date(
              event.created * 1000
            ).toISOString(),

          pendingWebhooks:
            event.pending_webhooks,

          account:
            event.account ?? null
        });
      }

      const paymentEvents =
        events.data.filter(
          event =>
            event.type.startsWith(
              'payment_intent.'
            ) ||
            event.type.startsWith(
              'charge.'
            )
        );

      if (paymentEvents.length === 0) {
        console.log(
          '⚠️ Não existem eventos recentes de PaymentIntent/Charge nesta conta/modo.'
        );
      }
    } catch (error) {
      console.error(
        '❌ Erro ao consultar eventos Stripe:',
        error.message
      );
    }
  }
}

main()
  .catch(error => {
    console.error(
      '❌ Diagnóstico falhou:',
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
