import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const dispatchMerchantWebhook = async (transactionId: string, eventType: string, providerPayload: any) => {
  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { store: true }
    });

    if (!transaction || !transaction.storeId) return false;

    // Procura o webhook vinculado à STORE (novo schema)
    const storeWebhook = await prisma.webhook.findFirst({
      where: { storeId: transaction.storeId, status: 'active' }
    });

    if (!storeWebhook || !storeWebhook.url) return false;

    // ... (restante da lógica de assinatura igual)
    return true;
  } catch (error) {
    return false;
  }
};
