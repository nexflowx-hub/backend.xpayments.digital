import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
export const getOverview = async (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { revenue: 0, volume: 0, approvalRate: 100, activeCustomers: 0, currency: "EUR", series: [], funnel: { initiated: 0, completed: 0, failed: 0, abandoned: 0 } } });
};
