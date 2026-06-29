import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

export class MisticPayService {
  async initiatePayment(txId: string, amount: number, customer: any, storeName: string) {
    console.log(`[MISTICPAY] A iniciar PIX via Master Account XPayments...`);

    // Busca EXCLUSIVAMENTE a nossa chave Master do cofre
    const vault = await prisma.gatewayVault.findUnique({ where: { providerId: 'MISTICPAY_MASTER' } });
    if (!vault || vault.status !== 'ACTIVE') throw new Error('Gateway MisticPay Master inativo.');

    const keys = JSON.parse(vault.authConfig);

    const payload = {
      amount,
      payerName: customer.fullName || 'Cliente XPayments',
      payerDocument: customer.taxId ? customer.taxId.replace(/\D/g, '') : '00000000000',
      transactionId: txId,
      description: `Compra na loja ${storeName}`
    };

    const res = await fetch('https://api.misticpay.com/api/transactions/create', {
      method: 'POST',
      headers: { 'ci': keys.ci, 'cs': keys.cs, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (data.data && data.data.qrCodeBase64) {
      return {
        gateway: 'MISTICPAY',
        providerTxId: String(data.data.transactionId),
        qrCode: data.data.qrCodeBase64,
        pixString: data.data.copyPaste
      };
    }
    
    throw new Error(`Falha na MisticPay: ${JSON.stringify(data)}`);
  }
}
