import { Request, Response } from 'express';

export const listTransactions = async (req: Request, res: Response) => {
  res.status(200).json({ 
    success: true, 
    data: [], 
    meta: { page: 1, limit: 10, total: 0, pages: 0 } 
  });
};

export const getTransactionStats = async (req: Request, res: Response) => {
  const stats = {
    total: 0,
    approved: 0,
    failed: 0,
    pending: 0,
    successRate: 0,
    volume: 0
  };

  res.status(200).json({
    success: true,
    data: stats, // Para interceptors rigorosos do Axios
    ...stats
  });
};

export const getTransaction = async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { id: req.params.id, status: 'PENDING', amount: 0, currency: 'EUR' }
  });
};
