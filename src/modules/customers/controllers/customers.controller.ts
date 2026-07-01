import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { CustomerService } from '../services/customers.service';

export const getCustomers = async (req: AuthRequest, res: Response) => {
  try {
    // O middleware já garantiu que req.merchantId existe e é válido!
    const customers = await CustomerService.getMerchantCustomers(req.merchantId!);
    res.json({ success: true, data: customers });
  } catch (error: any) { 
    res.status(500).json({ success: false, error: 'Erro ao carregar clientes' }); 
  }
};

export const getCustomerById = async (req: AuthRequest, res: Response) => {
  try {
    const customer = await CustomerService.getCustomerDetails(req.merchantId!, req.params.id);
    res.json({ success: true, data: customer });
  } catch (error: any) {
    res.status(404).json({ success: false, error: error.message });
  }
};
