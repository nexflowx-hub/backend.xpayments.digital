import { Request, Response } from 'express';

export const getOverview = async (req: Request, res: Response) => {
  const payload = {
    wallet: { totalBalance: 0, availableBalance: 0, currencies: [] },
    transactions: { today: 0, month: 0, total: 0, successRate: 0, volumeToday: 0, volumeMonth: 0 },
    recentTransactions: [],
    successRate: 0,
    balance: 0,
    volume: 0
  };

  res.status(200).json({
    success: true,
    data: payload, // Se o frontend esperar response.data.data
    ...payload     // Se o frontend esperar response.data direto
  });
};
