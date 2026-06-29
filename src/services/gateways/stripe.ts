import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const prisma = new PrismaClient();

export class StripeService {
  async initiatePayment(txId: string, amount: number, currency: string) {
    console.log(`[STRIPE] A iniciar PaymentIntent de ${amount} ${currency}...`);
    
    const vault = await prisma.gatewayVault.findUnique({ where: { providerId: 'STRIPE_MASTER' } });
    if (!vault || vault.status !== 'ACTIVE') throw new Error('Gateway Stripe Master inativo.');

    const keys = JSON.parse(vault.authConfig);
    
    // 🔴 A CORREÇÃO CIRÚRGICA: Aceitar 'publishableKey' ou 'publicKey'
    const pubKey = keys.publishableKey || keys.publicKey;

    if (!keys.secretKey || !pubKey || keys.secretKey.includes('master_...')) {
      throw new Error('As Chaves (Secret e Public) da Stripe no GatewayVault são inválidas ou estão em falta.');
    }

    // Inicializa a Stripe
    const stripe = new Stripe(keys.secretKey, { apiVersion: '2024-04-10' as any });
    const amountInCents = Math.round(amount * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency.toLowerCase(),
      metadata: { transactionId: txId },
      automatic_payment_methods: { enabled: true },
    });
    
    console.log(`[STRIPE] Sucesso! ClientSecret gerado para a tx ${txId}.`);
    
    return {
      gateway: 'STRIPE',
      providerTxId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      publicKey: pubKey // Envia a chave pública correta para o Frontend!
    };
  }
}
