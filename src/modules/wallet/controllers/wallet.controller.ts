import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { formatWallet } from '../../../core/utils/api-formatters';
export const getWallets = async (req: AuthRequest, res: Response) => {
  const wallets = await prisma.wallet.findMany({ where: { merchantId: req.user.id } });
  res.json({ success: true, data: wallets.map(formatWallet) });
};
export const getWalletMovements = async (req: AuthRequest, res: Response) => {
  const movements = await prisma.walletMovement.findMany({ where: { merchantId: req.user.id }, take: 50, orderBy: { createdAt: 'desc' } });
  res.json({ success: true, data: movements });
};
export const getPayouts = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const getDeposits = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const getTreasuryOverview = async (req: AuthRequest, res: Response) => res.json({
  success: true, data: { totalBalance: 0, availableBalance: 0, reservedBalance: 0, currency: 'EUR', liquidity: [], settlements: [], cashflow: [] }
});
