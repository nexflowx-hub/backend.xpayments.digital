import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { formatWallet } from '../../../core/utils/api-formatters';
import { listWalletOperations } from '../services/wallet-operations.service';

const merchantIdOf = (req: AuthRequest): string | null =>
  req.merchantId || req.user?.id || null;

export const getWallets = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdOf(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }

    const wallets = await prisma.wallet.findMany({
      where: { merchantId },
      orderBy: { currency: 'asc' }
    });

    const summary = {
      totalBalance: wallets.reduce((s, w) => s + Number(w.balance), 0),
      totalAvailable: wallets.reduce((s, w) => s + Number(w.available), 0),
      totalReserved: wallets.reduce((s, w) => s + Number(w.reserved), 0),
      currencies: wallets.length
    };

    return res.json({ success: true, data: { wallets: wallets.map(formatWallet), summary } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { message: 'Erro ao carregar wallets.' } });
  }
};

export const getWalletMovements = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdOf(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }

    const movements = await prisma.walletMovement.findMany({
      where: { merchantId },
      include: { wallet: { select: { currency: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return res.json({
      success: true,
      data: movements.map(m => ({ ...m, amount: Number(m.amount) }))
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { message: 'Erro ao carregar movimentos.' } });
  }
};

export const getPayouts = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdOf(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }
    const data = await listWalletOperations({ merchantId, type: 'withdrawal', limit: 50 });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[WALLET_PAYOUTS_ERROR]', error);
    return res.status(500).json({ success: false, error: { code: 'WALLET_PAYOUTS_ERROR', message: 'Erro ao carregar saques.' } });
  }
};

export const getDeposits = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdOf(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }
    const data = await listWalletOperations({ merchantId, type: 'deposit', limit: 50 });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[WALLET_DEPOSITS_ERROR]', error);
    return res.status(500).json({ success: false, error: { code: 'WALLET_DEPOSITS_ERROR', message: 'Erro ao carregar depósitos.' } });
  }
};

export const getTreasuryOverview = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdOf(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }

    const wallets = await prisma.wallet.findMany({ where: { merchantId } });
    const movements = await prisma.walletMovement.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    const data = {
      totalBalance: wallets.reduce((s, w) => s + Number(w.balance), 0),
      availableBalance: wallets.reduce((s, w) => s + Number(w.available), 0),
      reservedBalance: wallets.reduce((s, w) => s + Number(w.reserved), 0),
      currencies: wallets.length,
      wallets: wallets.map(formatWallet),
      recentMovements: movements.map(m => ({ ...m, amount: Number(m.amount) }))
    };

    return res.json({ success: true, data, ...data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { message: 'Erro ao carregar tesouraria.' } });
  }
};
