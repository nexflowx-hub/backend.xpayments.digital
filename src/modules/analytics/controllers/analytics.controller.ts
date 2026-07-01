import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { AnalyticsService } from '../services/analytics.service';

export const getDashboardAnalytics = async (req: AuthRequest, res: Response) => {
  try {
    const data = await AnalyticsService.getMerchantOverview(req.merchantId!);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Erro ao gerar Analytics' });
  }
};
