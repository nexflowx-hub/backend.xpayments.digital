import prisma from '../core/prisma';

export class TreasuryService {
  static async registerRevenue(transactionId: string, amountUSDT: number, description: string) {
    console.log(`[TREASURY] A registar receita: $${amountUSDT} USDT (${description})`);
    await prisma.treasuryLedger.create({
      data: {
        transactionId,
        type: 'FEE_REVENUE',
        amountUSDT,
        description
      }
    });
  }
}
