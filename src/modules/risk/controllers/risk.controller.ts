import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
export const getProfile = async (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { score: 0, reservePct: 10, chargebackRate: 0, trustStatus: 'standard', alerts: [] } });
};
export const getKycStatus = async (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { status: 'not_submitted', steps: [] } });
};
