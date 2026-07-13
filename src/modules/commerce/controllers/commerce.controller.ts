import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { formatTransaction, formatProduct, formatStore } from '../../../core/utils/api-formatters';

export const getTransactions = async (req: AuthRequest, res: Response) => {
  const transactions = await prisma.transaction.findMany({ where: { merchantId: req.user.id }, take: 10, orderBy: { createdAt: 'desc' } });
  const total = await prisma.transaction.count({ where: { merchantId: req.user.id } });
  // Transações tem um envelope misto exigido pelo Paginated<T>
  res.json({ success: true, data: transactions.map(formatTransaction), total, page: 1, pageSize: 10 });
};
export const getProducts = async (req: AuthRequest, res: Response) => {
  const items = await prisma.product.findMany({ where: { merchantId: req.user.id } });
  res.json({ success: true, data: items.map(formatProduct) });
};
export const createProduct = async (req: AuthRequest, res: Response) => res.json({ success: true, data: {} });
export const deleteProduct = async (req: AuthRequest, res: Response) => res.json({ success: true });

export const getStores = async (req: AuthRequest, res: Response) => {
  const items = await prisma.store.findMany({ where: { merchantId: req.user.id } });
  res.json({ success: true, data: items.map(formatStore) });
};

export const getPaymentLinks = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const getInvoices = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const getSubscriptions = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
