import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const prisma = new PrismaClient();

const parseRoutingRules = (value: unknown): Record<string, string> => {
    try {
        if (typeof value === 'string') return JSON.parse(value);
        if (value && typeof value === 'object') return value as Record<string, string>;
    } catch {}
    return {};
};

export const executePayment = async (data: {
    amount: number;
    currency: string;
    paymentMethod: string;
    storeId: string;
    metadata: any;
    merchantReference: string;
    environment?: 'live' | 'test';
}) => {
    const amountMinor = Number(data.amount);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error('INVALID_AMOUNT');
    }

    const store = await prisma.store.findUnique({
        where: { id: data.storeId }
    });

    if (!store || store.status !== 'active') {
        throw new Error('Loja inativa.');
    }

    const availableVaults = await prisma.gatewayVault.findMany({
        where: {
            merchantId: store.merchantId,
            isActive: true,
            OR: [{ storeId: null }, { storeId: store.id }]
        }
    });

    const routingRules = parseRoutingRules(store.routingRules);
    const method = String(data.paymentMethod || 'card').toLowerCase().replace(/-/g, '_');
    const dynamicStripeMode = method === 'stripe_all';
    let targetProvider: string | undefined = dynamicStripeMode
        ? routingRules.card
        : routingRules[method];

    if (!targetProvider && !dynamicStripeMode) {
        targetProvider = availableVaults.find((v) =>
            v.provider.toLowerCase() === method
        )?.provider;
    }

    if (!targetProvider && (method === 'card' || dynamicStripeMode)) {
        targetProvider = availableVaults.find((v) =>
            v.provider.toLowerCase().startsWith('stripe')
        )?.provider;
    }

    if (!targetProvider) targetProvider = availableVaults[0]?.provider;

    const gatewayVault = availableVaults.find((v) =>
        v.provider.toLowerCase() === targetProvider?.toLowerCase()
    );

    if (!gatewayVault) {
        throw new Error(`Nenhum Gateway configurado para ${method}`);
    }

    if (!gatewayVault.provider.toLowerCase().startsWith('stripe')) {
        throw new Error(`Provider ${gatewayVault.provider} ainda não suportado pelo adapter de cartão.`);
    }

    const credentials: any = gatewayVault.credentials || {};
    const secretKey = String(credentials.secretKey || '').trim();
    const publicKey = String(
        credentials.publishableKey || credentials.publicKey || ''
    ).trim();

    if (!secretKey || !publicKey) {
        throw new Error('Credenciais Stripe incompletas para o Checkout.');
    }

    const stripeEnvironment = secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')
        ? 'test'
        : secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')
            ? 'live'
            : 'unknown';

    if (data.environment && stripeEnvironment !== data.environment) {
        throw new Error(
            data.environment === 'live'
                ? 'LIVE_KEY_TEST_GATEWAY_MISMATCH'
                : 'TEST_KEY_LIVE_GATEWAY_MISMATCH'
        );
    }

    let transaction = await prisma.transaction.findFirst({
        where: {
            merchantId: store.merchantId,
            reference: data.merchantReference
        }
    });

    if (transaction?.status === 'succeeded') {
        throw new Error('TRANSACTION_ALREADY_PAID');
    }

    if (!transaction) {
        transaction = await prisma.transaction.create({
            data: {
                merchantId: store.merchantId,
                storeId: store.id,
                gatewayVaultId: gatewayVault.id,
                reference: data.merchantReference,
                amount: amountMinor / 100,
                currency: data.currency.toUpperCase(),
                status: 'pending',
                method,
                gateway: gatewayVault.provider,
                customerEmail: data.metadata?.email || data.metadata?.customerEmail || null,
                rawRequest: {
                    source: 'CHECKOUT',
                    amount: amountMinor,
                    currency: data.currency.toUpperCase(),
                    paymentMethod: method,
                    checkoutSessionId: data.metadata?.checkoutSessionId || null
                } as any
            }
        });
    } else {
        const canReuseProviderIntent =
            transaction.providerId &&
            transaction.status === 'pending' &&
            transaction.method === method &&
            transaction.gatewayVaultId === gatewayVault.id;

        transaction = await prisma.transaction.update({
            where: { id: transaction.id },
            data: {
                storeId: store.id,
                gatewayVaultId: gatewayVault.id,
                amount: amountMinor / 100,
                currency: data.currency.toUpperCase(),
                status: 'pending',
                method,
                gateway: gatewayVault.provider,
                customerEmail: data.metadata?.email || data.metadata?.customerEmail || null,
                ...(canReuseProviderIntent ? {} : { providerId: null })
            }
        });
    }

    const stripeClient = new Stripe(secretKey, {
        apiVersion: '2026-06-24.dahlia' as any
    });

    if (transaction.providerId) {
        const paymentIntent = await stripeClient.paymentIntents.retrieve(transaction.providerId);
        return {
            transactionId: transaction.id,
            gateway: 'STRIPE',
            checkoutData: {
                clientSecret: paymentIntent.client_secret,
                providerTxId: paymentIntent.id,
                publicKey,
                dynamicMethods: dynamicStripeMode
            },
            providerAction: paymentIntent
        };
    }

    const stripePayload: Stripe.PaymentIntentCreateParams = {
        amount: amountMinor,
        currency: data.currency.toLowerCase(),
        metadata: {
            nexflowx_transaction_id: transaction.id,
            merchant_reference: data.merchantReference,
            ...(data.metadata?.checkoutSessionId
                ? { checkout_session_id: String(data.metadata.checkoutSessionId) }
                : {})
        },
        ...(dynamicStripeMode
            ? { automatic_payment_methods: { enabled: true } }
            : { payment_method_types: ['card'] as any })
    };

    const idempotencyKey = [
        'xpayments-checkout',
        store.id,
        data.merchantReference,
        method
    ].join(':').slice(0, 255);

    const paymentIntent = await stripeClient.paymentIntents.create(
        stripePayload,
        { idempotencyKey }
    );

    await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
            providerId: paymentIntent.id,
            rawResponse: JSON.parse(JSON.stringify(paymentIntent))
        }
    });

    return {
        transactionId: transaction.id,
        gateway: 'STRIPE',
        checkoutData: {
            clientSecret: paymentIntent.client_secret,
            providerTxId: paymentIntent.id,
            publicKey,
            dynamicMethods: dynamicStripeMode
        },
        providerAction: paymentIntent
    };
};
