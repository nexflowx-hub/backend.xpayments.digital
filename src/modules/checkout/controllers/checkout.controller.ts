import { Request, Response } from 'express';
import { CheckoutService } from '../services/checkout.service';

export const createSession = async (req: Request, res: Response) => {
  try {
    const { storeId, amountFiat, currency, orderId, metadata } = req.body;
    const result = await CheckoutService.createSession(req.headers.authorization, storeId, Number(amountFiat), currency, orderId, metadata);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(error.message === 'Não autorizado' ? 401 : 500).json({ success: false, error: error.message });
  }
};

export const initiateCheckout = async (req: Request, res: Response) => {
  try {
    const { storeId, amountFiat, currency, customerDetails, metadata } = req.body;
    const result = await CheckoutService.initiateCheckout(storeId, Number(amountFiat), currency, customerDetails, metadata);
    res.json({ success: true, data: result });
  } catch (error: any) { 
    res.status(500).json({ success: false, error: error.message || 'Erro interno' }); 
  }
};
