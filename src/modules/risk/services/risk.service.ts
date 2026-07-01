import prisma from '../../../core/prisma';

export class RiskService {
  static async evaluateMerchantRisk(merchantId: string) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      include: { 
        transactions: { 
          where: { status: 'SUCCESS' },
          select: { amountUSDT: true, createdAt: true }
        } 
      }
    });

    if (!merchant) throw new Error('Lojista não encontrado');

    const totalVolume = merchant.transactions.reduce((acc, tx) => acc + Number(tx.amountUSDT), 0);
    
    // Algoritmo de Risco V1 (Baseado em Volume e Picos)
    let newRiskScore = 10; // Risco Saudável
    let newReservePercent = Number(merchant.reservePercent);
    let newReserveDays = merchant.reserveDays;
    let hasReserve = merchant.hasRiskReserve;

    // Regras de Negócio de Prevenção de Fraude
    if (totalVolume > 100000) {
      newRiskScore = 60; // Risco Elevado (Tier de Escala)
      newReservePercent = 10.00; // Retém 10% 
      newReserveDays = 14;       // Durante 14 dias
      hasReserve = true;
    } else if (totalVolume > 25000) {
      newRiskScore = 35; // Risco Moderado
      newReservePercent = 5.00;  // Retém 5%
      newReserveDays = 7;        // Durante 7 dias
      hasReserve = true;
    }

    // Se a máquina detetou mudança de comportamento, atualiza a Base de Dados
    if (merchant.riskScore !== newRiskScore || Number(merchant.reservePercent) !== newReservePercent) {
      await prisma.merchant.update({
        where: { id: merchantId },
        data: {
          riskScore: newRiskScore,
          reservePercent: newReservePercent,
          reserveDays: newReserveDays,
          hasRiskReserve: hasReserve,
          tier: newRiskScore >= 60 ? 'TIER_A_PREMIUM' : merchant.tier // Exemplo de auto-upgrade
        }
      });
    }

    return {
      riskScore: newRiskScore,
      securityStatus: newRiskScore < 40 ? 'SAFE' : 'REVIEW_NEEDED',
      reserve: {
        active: hasReserve,
        percentRetained: newReservePercent,
        holdingPeriodDays: newReserveDays
      },
      metrics: {
        totalVolumeProcessed: totalVolume
      }
    };
  }
}
