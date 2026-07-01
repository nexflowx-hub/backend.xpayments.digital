import prisma from '../prisma';
import crypto from 'crypto';

export const dispatchWebhook = async (storeId: string, event: string, payload: any) => {
  try {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (store && store.webhookUrl) {
      fetch(store.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-xpayments-signature': crypto.randomBytes(16).toString('hex') },
        body: JSON.stringify({ event, data: payload, timestamp: new Date() })
      }).catch(() => {});
    }
  } catch (error) {}
};
