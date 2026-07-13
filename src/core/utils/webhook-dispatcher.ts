import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export const dispatchMerchantWebhook = async (transactionId: string, eventType: string, providerPayload: any) => {
  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { store: { include: { webhooks: true } } }
    });

    if (!transaction || !transaction.store) return false;

    // Procura o webhook ativo para esta loja
    const activeWebhook = transaction.store.webhooks.find(w => w.status === 'active');
    if (!activeWebhook || !activeWebhook.url) return false;

    // Constrói o payload padronizado do XPayments
    const payload = {
      event: eventType,
      transaction_id: transaction.id,
      reference: transaction.reference,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      status: transaction.status,
      method: transaction.method,
      timestamp: new Date().toISOString()
    };

    const payloadString = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Se a loja tiver um secret, assina o payload para segurança deles
    if (activeWebhook.secret) {
      const signature = crypto.createHmac('sha256', activeWebhook.secret).update(payloadString).digest('hex');
      headers['x-nexflowx-signature'] = signature;
    }

    // Dispara via fetch nativo do Node.js 20
    const response = await fetch(activeWebhook.url, {
      method: 'POST',
      headers,
      body: payloadString
    });

    // Grava na BD o resultado do envio para auditoria
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        webhookSentLog: {
          url: activeWebhook.url,
          status: response.status,
          time: new Date().toISOString()
        }
      }
    });

    return response.ok;
  } catch (error) {
    console.error('[WEBHOOK DISPATCH ERROR]:', error);
    return false;
  }
};
