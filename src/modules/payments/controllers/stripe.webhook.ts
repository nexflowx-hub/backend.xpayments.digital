import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { dispatchMerchantWebhook } from '../../../core/utils/webhook-dispatcher';

const prisma = new PrismaClient();

export const handleStripeWebhook = async (req: Request, res: Response) => {
  try {
    const event = req.body; // Em prod, adicionar verificação de assinatura Stripe aqui

    // Apenas processamos eventos financeiros conclusivos
    if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      const transactionId = paymentIntent.metadata?.nexflowx_transaction_id;

      if (!transactionId) {
        console.log('⚠️ [STRIPE WEBHOOK] Ignorado: Sem nexflowx_transaction_id associado.');
        return res.status(200).send('Ignorado');
      }

      const transaction = await prisma.transaction.findUnique({
        where: { id: transactionId }
      });

      if (!transaction) {
        return res.status(404).send('Transação não encontrada');
      }

      const newStatus = event.type === 'payment_intent.succeeded' ? 'succeeded' : 'failed';

      // Impede processamento duplicado
      if (transaction.status === 'succeeded') {
        return res.status(200).send('Já processado');
      }

      // 1. Atualizar o Estado da Transação
      await prisma.transaction.update({
        where: { id: transactionId },
        data: {
          status: newStatus,
          rawResponse: paymentIntent 
        }
      });

      // 2. Fluxo Financeiro (Apenas se SUCESSO)
      if (newStatus === 'succeeded') {
        const currencyUpper = transaction.currency.toUpperCase();
        
        // Atualiza a Wallet ou cria uma nova se esta moeda ainda não existir para o Merchant
        const wallet = await prisma.wallet.upsert({
          where: {
            merchantId_currency: { merchantId: transaction.merchantId, currency: currencyUpper }
          },
          update: {
            balance: { increment: transaction.amount },
            available: { increment: transaction.amount }
          },
          create: {
            merchantId: transaction.merchantId,
            currency: currencyUpper,
            balance: transaction.amount,
            available: transaction.amount,
            type: 'fiat'
          }
        });

        // Grava o movimento de entrada
        await prisma.walletMovement.create({
          data: {
            walletId: wallet.id,
            merchantId: transaction.merchantId,
            currency: currencyUpper,
            type: 'payment',
            direction: 'in',
            amount: transaction.amount,
            status: 'disponivel',
            reference: transaction.id
          }
        });
      }

      // 3. Notificar a Loja específica
      await dispatchMerchantWebhook(transaction.id, event.type, paymentIntent);
    }

    // A Stripe exige um 200 rápido
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('[STRIPE WEBHOOK FATAL ERROR]:', error);
    return res.status(500).send('Erro interno do servidor');
  }
};
