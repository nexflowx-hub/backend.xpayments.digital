import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../../../core/prisma';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';

export const merchantLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant || merchant.password !== password) return res.status(401).json({ success: false, error: 'Credenciais inválidas.' });
    if (merchant.status !== 'ACTIVE') return res.status(403).json({ success: false, error: 'Conta suspensa.' });
    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, data: { merchantId: merchant.id, name: merchant.name, tier: merchant.tier, token, role: 'merchant' } });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const merchantRegister = async (req: Request, res: Response) => {
  try {
    const { name, storeName, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Obrigatório.' });
    const existing = await prisma.merchant.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ success: false, error: 'Em uso.' });

    const finalName = name || email.split('@')[0];
    const finalStoreName = storeName || 'Loja Principal';

    const result = await prisma.$transaction(async (tx) => {
      let defaultFee = await tx.feeProfile.findUnique({ where: { name: 'Starter Plan' } });
      if (!defaultFee) defaultFee = await tx.feeProfile.create({ data: { name: 'Starter Plan' } });

      const merchant = await tx.merchant.create({
        data: { name: finalName, email, password, status: 'ACTIVE', tier: 'TIER_C_STANDARD', feeProfileId: defaultFee.id }
      });
      await tx.store.create({
        data: { merchantId: merchant.id, name: finalStoreName, primaryColor: '#10b981', checkoutConfig: { allowedMethods: ["CARD", "MBWAY", "PIX"], defaultCurrency: "EUR" } }
      });
      await tx.apiKey.create({
        data: { merchantId: merchant.id, merchantName: 'Chave API Master', publicKey: 'pk_live_' + crypto.randomBytes(16).toString('hex'), secretKey: 'sk_live_' + crypto.randomBytes(32).toString('hex') }
      });
      return merchant;
    });

    const token = jwt.sign({ id: result.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, data: { merchantId: result.id, name: result.name, tier: result.tier, token, role: 'merchant' } });
  } catch (error: any) { res.status(500).json({ success: false }); }
};

export const adminLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin || admin.password !== password) return res.status(401).json({ success: false });
    const token = jwt.sign({ id: admin.id, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, data: { adminId: admin.id, name: admin.name, role: 'admin', token } });
  } catch (error) { res.status(500).json({ success: false }); }
};
