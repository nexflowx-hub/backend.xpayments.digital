import prisma from '../../../core/prisma';

export class CustomerService {
  static async getMerchantCustomers(merchantId: string) {
    // Traz os clientes e as suas transações aprovadas para calcularmos o valor deles
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

    // Mapeia para adicionar o Lifetime Value (LTV) e Total de Compras
    return customers.map(customer => {
      const totalSpent = customer.transactions.reduce((acc, tx) => acc + Number(tx.amountUSDT), 0);
      const lastPurchase = customer.transactions.length > 0 ? customer.transactions[0].createdAt : null;
      
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        taxId: customer.taxId,
        createdAt: customer.createdAt,
        stats: {
          totalPurchases: customer.transactions.length,
          lifetimeValueUSDT: totalSpent,
          lastPurchaseAt: lastPurchase
        }
      };
    });
  }

  static async getCustomerDetails(merchantId: string, customerId: string) {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, merchantId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    if (!customer) throw new Error('Cliente não encontrado');
    return customer;
  }
}
