import { Request, Response } from 'express';
import prisma from '../../../core/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { formatMerchantSession } from '../../../core/utils/api-formatters';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';
interface AuthRequest extends Request { user?: any; }

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const merchant = await prisma.merchant.findUnique({ where: { email } });

    if (!merchant || !(await bcrypt.compare(password, merchant.passwordHash))) {
      return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
    }

    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });
    res.status(200).json({ success: true, data: formatMerchantSession(merchant, token) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, name, companyName } = req.body;
    if (!email || !password || !name) return res.status(400).json({ success: false, message: 'Faltam dados obrigatórios.' });

    const existingMerchant = await prisma.merchant.findUnique({ where: { email } });
    if (existingMerchant) return res.status(400).json({ success: false, message: 'Este email já está registado.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const merchant = await prisma.$transaction(async (tx) => {
      const newMerchant = await tx.merchant.create({
        data: { email, name, company: companyName || '', passwordHash, status: 'active' }
      });
      await tx.wallet.create({
        data: { merchantId: newMerchant.id, currency: 'EUR', label: 'Conta Principal (EUR)', type: 'fiat' }
      });
      return newMerchant;
    });

    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ success: true, data: formatMerchantSession(merchant, token) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const me = async (req: AuthRequest, res: Response) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.user.id } });
    if (!merchant) return res.status(401).json({ success: false, message: 'Comerciante não encontrado.' });
    res.status(200).json({ success: true, data: formatMerchantSession(merchant) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const logout = (req: Request, res: Response) => res.status(200).json({ success: true, message: 'Sessão terminada.' });
