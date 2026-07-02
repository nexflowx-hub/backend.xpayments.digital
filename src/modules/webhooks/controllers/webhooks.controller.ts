import { Request, Response } from 'express';
import prisma from '../../../core/prisma';
import { LedgerService } from '../../../services/ledger.service';

export const misticpayWebhook = async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    if (payload.status === 'COMPLETO' && payload.transactionType === 'DEPOSITO') {
      const tx = await prisma.transaction.findFirst({ where: { providerTxId: String(payload.transactionId), providerUsed: 'MISTICPAY' } });
      if (tx) {
        // A MisticPay nem sempre envia um eventID isolado, usamos o transactionId gerado
        const eventId = req.headers['x-misticpay-event-id'] as string || `mistic_${payload.transactionId}`;
        await LedgerService.processPaymentSuccess(tx.id, 'MISTICPAY', eventId);
      }
    }
    res.status(200).json({ received: true });
  } catch (error) { res.status(500).json({ error: 'Erro Webhook' }); }
};

export const stripeWebhook = async (req: Request, res: Response) => {
  try {
    const event = req.body;
    const eventId = event.id; // Stripe envia sempre um event.id garantido (ex: evt_12345)
    
    if (event.type === 'payment_intent.succeeded') {
      const txId = event.data.object.metadata?.transactionId;
      if (txId) await LedgerService.processPaymentSuccess(txId, 'STRIPE', eventId);
    }
    res.status(200).json({ received: true });
  } catch (error) { res.status(500).json({ error: 'Erro Webhook Stripe' }); }
};

export const simulateSuccess = async (req: Request, res: Response) => {
  try {
    const { providerTxId } = req.body;
    const tx = await prisma.transaction.findFirst({ where: { providerTxId } });
    if (tx) {
      const eventId = `sim_${providerTxId}_${Date.now()}`;
      await LedgerService.processPaymentSuccess(tx.id, 'SIMULATOR', eventId);
    }
    res.json({ success: true, message: 'Faturação Transacional concluída.' });
  } catch (error) { res.status(500).json({ success: false }); }
};
