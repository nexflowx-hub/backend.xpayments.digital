import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';

export interface AdminRequest extends Request {
  adminId?: string;
}

export const authenticateAdmin = (req: AdminRequest, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'Token ausente.' });
    
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    
    // 🔴 A grande diferença: Só passa quem tem a role 'admin'
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acesso restrito à Administração XPayments.' });
    }
    
    req.adminId = decoded.id;
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: 'Token inválido ou expirado.' });
  }
};
