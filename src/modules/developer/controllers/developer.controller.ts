import { Response } from 'express';
import crypto from 'crypto';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const getApiKeys = async (req: AuthRequest, res: Response) => {
  try {
    const keys = await prisma.apiKey.findMany({ where: { merchantId: req.merchantId! }, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: keys });
  } catch (error) { res.json({ success: true, data: [] }); }
};

export const generateApiKey = async (req: AuthRequest, res: Response) => {
  try {
    const publicKey = 'pk_live_' + crypto.randomBytes(16).toString('hex');
    const secretKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    const newKey = await prisma.apiKey.create({ data: { merchantId: req.merchantId!, merchantName: req.body?.name || 'Chave API', publicKey, secretKey } });
    res.json({ success: true, data: newKey });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const deleteApiKey = async (req: AuthRequest, res: Response) => {
  try {
    await prisma.apiKey.deleteMany({ where: { id: req.params.id, merchantId: req.merchantId! } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
};
