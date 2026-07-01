import prisma from '../../../core/prisma';

export class AnalyticsService {
  static async getMerchantOverview(merchantId: string) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Buscar todas as transações para calcular taxas de conversão
    const allTxs = await prisma.transaction.findMany({ 
      where: { merchantId },
      select: { amountUSDT: true, feeUSDT: true, netAmountUSDT: true, status: true, createdAt: true, currency: true }
    });

    const successfulTxs = allTxs.filter(tx => tx.status === 'SUCCESS');

    // Cálculos de Volume Temporal
    const volumeToday = successfulTxs
      .filter(tx => new Date(tx.createdAt) >= startOfDay)
      .reduce((sum, tx) => sum + Number(tx.amountUSDT), 0);

    const volumeMonth = successfulTxs
      .filter(tx => new Date(tx.createdAt) >= startOfMonth)
      .reduce((sum, tx) => sum + Number(tx.amountUSDT), 0);

    // Taxa de Conversão (Sucessos vs Total de Tentativas de Checkout)
    const conversionRate = allTxs.length > 0 ? (successfulTxs.length / allTxs.length) * 100 : 0;

    // Resumo Financeiro Lifetime (Gross, Fees e Net)
    const totalGross = successfulTxs.reduce((sum, tx) => sum + Number(tx.amountUSDT), 0);
    const totalFees = successfulTxs.reduce((sum, tx) => sum + Number(tx.feeUSDT), 0);
    const totalNet = successfulTxs.reduce((sum, tx) => sum + Number(tx.netAmountUSDT), 0);

    // Agrupamento por Moeda (EUR vs BRL)
    const currencySplit = successfulTxs.reduce((acc: any, tx) => {
      acc[tx.currency] = (acc[tx.currency] || 0) + Number(tx.amountUSDT);
      return acc;
    }, {});

    return {
      timeframes: {
        today: volumeToday,
        month: volumeMonth
      },
      conversion: {
        rate: Number(conversionRate.toFixed(2)),
        totalAttempts: allTxs.length,
        successful: successfulTxs.length
      },
      financials: {
        grossProcessedUSDT: totalGross,
        feesPaidUSDT: totalFees,
        netRevenueUSDT: totalNet
      },
      currencySplit
    };
  }
}
