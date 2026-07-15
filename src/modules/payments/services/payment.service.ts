import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const prisma = new PrismaClient();

export const executePayment = async (data: {
    amount: number;
    currency: string;
    paymentMethod: string;
    storeId: string;
    metadata: any;
    merchantReference: string;
}) => {

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
            OR: [ { storeId: null }, { storeId: store.id } ]
        }
    });

    const routingRules: any = store.routingRules || {};
    let targetProvider = routingRules[data.paymentMethod];

    if (!targetProvider) {
        targetProvider = availableVaults.find(v =>
            v.provider.toLowerCase() === data.paymentMethod.toLowerCase()
        )?.provider;
    }

    if (!targetProvider) {
        targetProvider = availableVaults[0]?.provider;
    }

    const gatewayVault = availableVaults.find(v =>
        v.provider.toLowerCase() === targetProvider?.toLowerCase()
    );

    if (!gatewayVault) {
        throw new Error(`Nenhum Gateway configurado para ${data.paymentMethod}`);
    }

    let transaction = await prisma.transaction.findFirst({
        where: { reference: data.merchantReference }
    });

    if (!transaction) {
        transaction = await prisma.transaction.create({
            data: {
                merchantId: store.merchantId,
                storeId: store.id,
                gatewayVaultId: gatewayVault.id,
                reference: data.merchantReference,
                amount: data.amount,
                currency: data.currency,
                status: 'pending',
                method: data.paymentMethod,
                gateway: gatewayVault.provider
            }
        });
    }

    if (gatewayVault.provider.toLowerCase().startsWith('stripe')) {
        const credentials: any = gatewayVault.credentials;
        const stripeClient = new Stripe(credentials.secretKey, { apiVersion: '2026-06-24.dahlia' as any });

        if (transaction.providerId) {
            const paymentIntent = await stripeClient.paymentIntents.retrieve(transaction.providerId);
            return {
                transactionId: transaction.id,
                gateway: 'STRIPE',
                checkoutData: { clientSecret: paymentIntent.client_secret, providerTxId: paymentIntent.id, publicKey: credentials.publicKey },
                providerAction: paymentIntent
            };
        }

        const methodMapping: Record<string, string[]> = {
            card: ['card'],
            visa: ['card'],
            mastercard: ['card'],
            amex: ['card'],
            pix: ['pix'],
            multibanco: ['multibanco'],
            mb_way: ['mb_way'], // CORRIGIDO
            mbway: ['mb_way'],  // CORRIGIDO
            bizum: ['bizum'],
            ideal: ['ideal'],
            bancontact: ['bancontact'],
            blik: ['blik'],
            eps: ['eps'],
            klarna: ['klarna'],
            amazon_pay: ['amazon_pay']
        };

        const paymentMethodTypes = methodMapping[data.paymentMethod.toLowerCase()] || ['card'];

        const stripePayload: any = {
            amount: data.amount,
            currency: data.currency.toLowerCase(),
            payment_method_types: paymentMethodTypes,
            metadata: {
                nexflowx_transaction_id: transaction.id,
                nexor_reference: data.merchantReference,
                ...(data.metadata || {})
            }
        };

        const paymentIntent = await stripeClient.paymentIntents.create(stripePayload);

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
            checkoutData: { clientSecret: paymentIntent.client_secret, providerTxId: paymentIntent.id, publicKey: credentials.publicKey },
            providerAction: paymentIntent
        };
    }

    throw new Error(`Provider ${gatewayVault.provider} ainda não suportado.`);
};
