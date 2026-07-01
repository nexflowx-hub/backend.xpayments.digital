import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';

export interface AuthRequest extends Request {
  merchantId?: string;
  adminId?: string;
}

export const authenticateMerchant = (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'Token ausente. Acesso negado.' });
    
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.role !== 'merchant') return res.status(403).json({ success: false, error: 'Privilégios insuficientes.' });
    
    req.merchantId = decoded.id; // Injeta o ID diretamente no request!
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: 'Token inválido ou expirado.' });
  }
};
