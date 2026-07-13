import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const getMerchants = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const updateMerchantStatus = async (req: AuthRequest, res: Response) => res.json({ success: true });
export const getKycReviews = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const approveKyc = async (req: AuthRequest, res: Response) => res.json({ success: true });
export const rejectKyc = async (req: AuthRequest, res: Response) => res.json({ success: true });
export const getTreasuryOverview = async (req: AuthRequest, res: Response) => res.json({
  success: true, data: { totalBalance: 0, availableBalance: 0, reservedBalance: 0, currency: 'EUR', liquidity: [], settlements: [], cashflow: [] }
});
export const getRevenue = async (req: AuthRequest, res: Response) => res.json({ success: true, data: { total: 0, series: [] } });
export const getHealth = async (req: AuthRequest, res: Response) => res.json({ success: true, data: { status: 'healthy', uptime: 100, workers: [], queues: [], incidents: [] } });
