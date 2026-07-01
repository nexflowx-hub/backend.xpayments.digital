import { Request, Response } from 'express';
import prisma from '../../../core/prisma';
import { LedgerService } from '../../../services/ledger.service';

export const misticpayWebhook = async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    if (payload.status === 'COMPLETO' && payload.transactionType === 'DEPOSITO') {
      const tx = await prisma.transaction.findFirst({ where: { providerTxId: String(payload.transactionId), providerUsed: 'MISTICPAY' } });
      if (tx) await LedgerService.processPaymentSuccess(tx.id);
    }
    res.status(200).json({ received: true });
  } catch (error) { res.status(500).json({ error: 'Erro Webhook' }); }
};

export const stripeWebhook = async (req: Request, res: Response) => {
  try {
    const event = req.body;
    if (event.type === 'payment_intent.succeeded') {
      const txId = event.data.object.metadata?.transactionId;
      if (txId) await LedgerService.processPaymentSuccess(txId);
    }
    res.status(200).json({ received: true });
  } catch (error) { res.status(500).json({ error: 'Erro Webhook Stripe' }); }
};

export const simulateSuccess = async (req: Request, res: Response) => {
  try {
    const { providerTxId } = req.body;
    const tx = await prisma.transaction.findFirst({ where: { providerTxId } });
    if (tx) await LedgerService.processPaymentSuccess(tx.id);
    res.json({ success: true, message: 'Faturação com Ledger Service concluída.' });
  } catch (error) { res.status(500).json({ success: false }); }
};
