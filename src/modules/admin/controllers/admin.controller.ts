import { Response } from 'express';
import { AdminRequest } from '../../../middleware/admin.middleware';
import { AdminService } from '../services/admin.service';

export const getGateways = async (req: AdminRequest, res: Response) => {
  try {
    const gateways = await AdminService.getAllGateways();
    res.json({ success: true, data: gateways });
  } catch (error: any) { 
    res.status(500).json({ success: false, error: 'Erro ao carregar Gateways' }); 
  }
};

export const updateGateway = async (req: AdminRequest, res: Response) => {
  try {
    const { status, lifecycleStatus } = req.body;
    const updated = await AdminService.updateGatewayStatus(req.params.providerId, status, lifecycleStatus);
    res.json({ success: true, data: updated });
  } catch (error: any) { 
    res.status(500).json({ success: false, error: 'Erro ao atualizar Gateway' }); 
  }
};

export const getPlatformStats = async (req: AdminRequest, res: Response) => {
  try {
    const stats = await AdminService.getPlatformStats();
    res.json({ success: true, data: stats });
  } catch (error: any) { 
    res.status(500).json({ success: false, error: 'Erro ao carregar estatísticas' }); 
  }
};
