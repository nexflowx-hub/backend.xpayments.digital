import prisma from '../../../core/prisma';

export class CustomersService {
  static async getMerchantCustomers(merchantId: string) {
    const customers = await prisma.customer.findMany({
      where: { merchantId },
      include: {
        transactions: {
          where: { status: 'SUCCESS' },
          select: { amountUSDT: true, createdAt: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Mapear para o formato exato que o Frontend (Z.AI) está à espera
    return customers.map(c => {
      const txs = c.transactions || [];
      const ltv = txs.reduce((sum, tx) => sum + Number(tx.amountUSDT), 0);
      
      // Encontrar a data da última compra
      const lastTx = txs.length > 0 
        ? txs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0].createdAt 
        : null;

      return {
        id: c.id,
        name: c.name,
        email: c.email,
        taxId: c.taxId,
        createdAt: c.createdAt,
        stats: {
          totalPurchases: txs.length,
          lifetimeValueUSDT: ltv,
          lastPurchaseAt: lastTx
        }
      };
    });
  }
}
