import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const findOwnedStore = async (merchantId: string, storeId: string) =>
  prisma.store.findFirst({ where: { id: storeId, merchantId }, select: { id: true } });

export const listGateways = async (req: AuthRequest, res: Response) => {
  const gateways = await prisma.gatewayVault.findMany({
    where: { merchantId: req.user.id },
    orderBy: { createdAt: 'desc' }
  });
  return res.json({ success: true, data: gateways });
};

export const getGateway = async (req: AuthRequest, res: Response) => {
  const gateway = await prisma.gatewayVault.findFirst({
    where: { id: String(req.params.id), merchantId: req.user.id }
  });

  if (!gateway) {
    return res.status(404).json({ success: false, error: { message: 'Gateway não encontrado.' } });
  }

  return res.json({ success: true, data: gateway });
};

export const createGateway = async (req: AuthRequest, res: Response) => {
  const merchantId = String(req.user.id);
  const storeId = req.body?.storeId ? String(req.body.storeId) : null;
  const provider = String(req.body?.provider || '').trim();
  const credentials = req.body?.credentials;
  const isActive = req.body?.isActive;

  if (!provider || !credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return res.status(400).json({
      success: false,
      error: { message: 'Provider e credentials válidos são obrigatórios.' }
    });
  }

  if (storeId && !(await findOwnedStore(merchantId, storeId))) {
    return res.status(403).json({
      success: false,
      error: { message: 'Store não pertence ao Merchant autenticado.' }
    });
  }

  const gateway = await prisma.gatewayVault.create({
    data: { merchantId, storeId, provider, credentials, isActive: isActive ?? true }
  });

  return res.status(201).json({ success: true, data: gateway });
};

export const updateGateway = async (req: AuthRequest, res: Response) => {
  const merchantId = String(req.user.id);
  const id = String(req.params.id);

  const existing = await prisma.gatewayVault.findFirst({ where: { id, merchantId } });
  if (!existing) {
    return res.status(404).json({ success: false, error: { message: 'Gateway não encontrado.' } });
  }

  const data: { storeId?: string | null; provider?: string; credentials?: object; isActive?: boolean } = {};

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'storeId')) {
    const nextStoreId = req.body.storeId ? String(req.body.storeId) : null;
    if (nextStoreId && !(await findOwnedStore(merchantId, nextStoreId))) {
      return res.status(403).json({ success: false, error: { message: 'Store não pertence ao Merchant autenticado.' } });
    }
    data.storeId = nextStoreId;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'provider')) {
    const provider = String(req.body.provider || '').trim();
    if (!provider) return res.status(400).json({ success: false, error: { message: 'Provider inválido.' } });
    data.provider = provider;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'credentials')) {
    const credentials = req.body.credentials;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return res.status(400).json({ success: false, error: { message: 'Credentials inválidas.' } });
    }
    data.credentials = credentials;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'isActive')) data.isActive = Boolean(req.body.isActive);

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ success: false, error: { message: 'Nenhum campo mutável válido foi fornecido.' } });
  }

  const gateway = await prisma.gatewayVault.update({ where: { id }, data });
  return res.json({ success: true, data: gateway });
};

export const deleteGateway = async (req: AuthRequest, res: Response) => {
  const merchantId = String(req.user.id);
  const id = String(req.params.id);

  const existing = await prisma.gatewayVault.findFirst({ where: { id, merchantId }, select: { id: true } });
  if (!existing) {
    return res.status(404).json({ success: false, error: { message: 'Gateway não encontrado.' } });
  }

  await prisma.gatewayVault.delete({ where: { id: existing.id } });
  return res.json({ success: true });
};
