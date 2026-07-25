import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { dispatchMerchantWebhook } from '../../../core/utils/webhook-dispatcher';

const prisma = new PrismaClient();

export const handleStripeWebhook = async (req: Request, res: Response) => {
  try {
    const event = req.body;

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

      if (transaction.status === 'succeeded') {
        return res.status(200).send('Já processado');
      }

      // --- 1. LÓGICA DE FEES E LIQUIDAÇÃO ---
      const amountNum = Number(transaction.amount); // Ex: 15.00
      const feeRate = 0.02; // 2% XPayments Fee
      
      const totalFee = newStatus === 'succeeded' ? Number((amountNum * feeRate).toFixed(2)) : 0;
      const netAmount = newStatus === 'succeeded' ? Number((amountNum - totalFee).toFixed(2)) : 0;

      // 2. Atualizar o Estado da Transação (gravando o Lucro)
      await prisma.transaction.update({
        where: { id: transactionId },
        data: {
          status: newStatus,
          fee: totalFee, // Guardamos a taxa
          rawResponse: paymentIntent
        }
      });

      // 3. Fluxo Financeiro (Apenas se SUCESSO)
      if (newStatus === 'succeeded') {
        const currencyUpper = transaction.currency.toUpperCase();

        // Atualiza a Wallet apenas com o Net Amount. O Available Fica INTACTO (D+3)
        const wallet = await prisma.wallet.upsert({
          where: {
            merchantId_currency: { merchantId: transaction.merchantId, currency: currencyUpper }
          },
          update: {
            balance: { increment: netAmount }
          },
          create: {
            merchantId: transaction.merchantId,
            currency: currencyUpper,
            balance: netAmount,
            available: 0, // Entra a zeros
            type: 'fiat'
          }
        });

        // Grava o movimento como PENDENTE
        await prisma.walletMovement.create({
          data: {
            walletId: wallet.id,
            merchantId: transaction.merchantId,
            currency: currencyUpper,
            type: 'payment',
            direction: 'in',
            amount: netAmount,
            status: 'pendente', // D+3
            reference: transaction.id
          }
        });
      }

      // 4. Notificar a Loja específica
      await dispatchMerchantWebhook(transaction.id, event.type, paymentIntent);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('[STRIPE WEBHOOK FATAL ERROR]:', error);
    return res.status(500).send('Erro interno do servidor');
  }
};
