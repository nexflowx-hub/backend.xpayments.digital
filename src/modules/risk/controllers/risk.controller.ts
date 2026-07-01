import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { RiskService } from '../services/risk.service';

export const getRiskProfile = async (req: AuthRequest, res: Response) => {
  try {
    const profile = await RiskService.evaluateMerchantRisk(req.merchantId!);
    res.json({ success: true, data: profile });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Erro ao calcular Perfil de Risco' });
  }
};
