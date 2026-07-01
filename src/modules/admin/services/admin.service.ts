import prisma from '../../../core/prisma';

export class AdminService {
  // Gestão de Gateways
  static async getAllGateways() {
    return await prisma.gatewayVault.findMany({
      orderBy: { providerId: 'asc' }
    });
  }

  static async updateGatewayStatus(providerId: string, status: string, lifecycleStatus: string) {
    return await prisma.gatewayVault.update({
      where: { providerId },
      data: { status, lifecycleStatus }
    });
  }

  // Visão Global da Plataforma
  static async getPlatformStats() {
    const totalMerchants = await prisma.merchant.count();
    
    const totalVolume = await prisma.transaction.aggregate({
      where: { status: 'SUCCESS' },
      _sum: { amountUSDT: true, feeUSDT: true }
    });

    const activeStores = await prisma.store.count({ where: { isActive: true } });

    return {
      totalMerchants,
      activeStores,
      financials: {
        totalVolumeProcessed: Number(totalVolume._sum.amountUSDT || 0),
        totalRevenueXPayments: Number(totalVolume._sum.feeUSDT || 0)
      }
    };
  }
}
