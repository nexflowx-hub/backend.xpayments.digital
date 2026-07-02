import prisma from '../core/prisma';
import { dispatchWebhook } from '../core/utils/notifications';

export class LedgerService {
  static async processPaymentSuccess(txId: string, provider: string, providerEventId: string) {
    
    // 1. IDEMPOTÊNCIA: Verifica se o evento já foi processado para evitar fundos duplicados
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider, providerEventId } }
    });
    
    if (existingEvent) {
      console.log(`[IDEMPOTÊNCIA] O evento ${providerEventId} da ${provider} já foi processado. Ignorado.`);
      return;
    }

    try {
      // 2. TRANSAÇÃO ATÓMICA: Ou regista tudo, ou reverte tudo!
      await prisma.$transaction(async (txPrisma) => {
        const tx = await txPrisma.transaction.findUnique({ where: { id: txId } });
        if (!tx || tx.status === 'SUCCESS') return;

        // A) Regista o evento de Webhook
        await txPrisma.webhookEvent.create({
          data: { provider, providerEventId, status: 'PROCESSED' }
        });

        // B) Atualiza a transação para Sucesso
        await txPrisma.transaction.update({ where: { id: tx.id }, data: { status: 'SUCCESS' } });
        
        // C) Regista a entrada no Ledger (Extrato detalhado)
        const ledgerType = tx.type === 'DEPOSIT' ? 'DEPOSIT' : 'PAYMENT';
        await txPrisma.ledger.create({ 
          data: { merchantId: tx.merchantId, transactionId: tx.id, type: ledgerType, amountUSDT: Number(tx.netAmountUSDT), status: 'AVAILABLE', availableAt: new Date() } 
        });
        
        // D) Regista o Lucro da Plataforma (Treasury)
        if (Number(tx.feeUSDT) > 0) {
          await txPrisma.treasuryLedger.create({
            data: { transactionId: tx.id, type: 'FEE_REVENUE', amountUSDT: Number(tx.feeUSDT), description: `Taxa processada da loja ${tx.merchantName || 'ID:'+tx.merchantId}` }
          });
        }

        // 🔴 E) A GRANDE ATUALIZAÇÃO DA WALLET: Deposita instantaneamente o dinheiro
        await txPrisma.wallet.upsert({
          where: { merchantId_currency: { merchantId: tx.merchantId, currency: 'USDT' } },
          update: {
            balance: { increment: Number(tx.netAmountUSDT) },
            available: { increment: Number(tx.netAmountUSDT) }
          },
          create: {
            merchantId: tx.merchantId,
            currency: 'USDT',
            balance: Number(tx.netAmountUSDT),
            available: Number(tx.netAmountUSDT)
          }
        });

        // F) Disparo de Webhook assíncrono para o Lojista
        if (tx.storeId) {
          setTimeout(() => {
            dispatchWebhook(tx.storeId!, 'payment.success', { transactionId: tx.id, amount: Number(tx.amountFiat), currency: tx.currency, customer: tx.customerEmail });
          }, 0);
        }
      });
      
      console.log(`[LEDGER & WALLET] Contabilidade da Transação ${txId} selada com sucesso.`);
    } catch (error) {
      console.error('[LEDGER FATAL ERROR] A transação falhou e os fundos foram revertidos:', error);
      throw error;
    }
  }
}
