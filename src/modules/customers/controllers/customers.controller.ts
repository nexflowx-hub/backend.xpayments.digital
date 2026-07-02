import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { CustomersService } from '../services/customers.service';

export const getCustomers = async (req: AuthRequest, res: Response) => {
  try {
    const customers = await CustomersService.getMerchantCustomers(req.merchantId!);
    res.json({ success: true, data: customers });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Erro ao carregar clientes e LTV' });
  }
};
