import prisma from '../core/prisma';
import { dispatchWebhook } from '../core/utils/notifications';
import { TreasuryService } from './treasury.service';

export class LedgerService {
  static async processPaymentSuccess(txId: string) {
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || tx.status === 'SUCCESS') return;

    // 1. Atualizar transação
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'SUCCESS' } });
    
    // 2. Crédito ao Lojista (Ledger)
    const ledgerType = tx.type === 'DEPOSIT' ? 'DEPOSIT' : 'PAYMENT';
    await prisma.ledger.create({ 
      data: { 
        merchantId: tx.merchantId, 
        transactionId: tx.id, 
        type: ledgerType, 
        amountUSDT: Number(tx.netAmountUSDT), 
        status: 'AVAILABLE', 
        availableAt: new Date() 
      } 
    });
    
    // 3. Crédito à XPayments (Treasury - Lucro das taxas)
    if (Number(tx.feeUSDT) > 0) {
      await TreasuryService.registerRevenue(tx.id, Number(tx.feeUSDT), `Faturação de ${tx.type} da Loja ${tx.merchantName}`);
    }

    // 4. Disparo de Webhook
    if (tx.storeId) {
      await dispatchWebhook(tx.storeId, 'payment.success', { 
        transactionId: tx.id, 
        amount: Number(tx.amountFiat), 
        currency: tx.currency, 
        customer: tx.customerEmail 
      });
    }
  }
}
