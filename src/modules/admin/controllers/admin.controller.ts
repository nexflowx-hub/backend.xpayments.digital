import { Request, Response } from 'express';

export const getMerchants = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: [] });
};

export const updateMerchantStatus = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, status: req.body?.status || 'ACTIVE' });
};

export const getKycReviews = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: [] });
};

export const approveKyc = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, message: 'KYC Aprovado (Stub)' });
};

export const rejectKyc = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, message: 'KYC Rejeitado (Stub)' });
};

export const getTreasuryOverview = async (req: Request, res: Response) => {
  res.status(200).json({ 
    success: true, 
    data: { totalBalance: 0, availableBalance: 0, reservedBalance: 0, wallets: [] } 
  });
};

export const getRevenue = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: { total: 0, metrics: [] } });
};

export const getHealth = async (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
};

// Stub funcional da geração de chaves (para não quebrar a funcionalidade já existente)
export const generateApiKey = async (req: Request, res: Response) => {
  const env = req.body?.environment || 'test';
  res.status(201).json({ success: true, key: `xp_${env}_stubbedkey_${Date.now()}` });
};
