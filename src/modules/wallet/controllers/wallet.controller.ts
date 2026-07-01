import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { FXService } from '../../../core/services/fx.service';
import { FeeService } from '../../../core/services/fee.service';
import { GatewayRouter } from '../../../services/gateways';

export const getDashboard = async (req: AuthRequest, res: Response) => {
  try {
    // 🔴 SEGURANÇA MÁXIMA: Ignoramos o ID da URL e usamos o do Token validado!
    const merchantId = req.merchantId!;
    const ledgers = await prisma.ledger.groupBy({ by: ['status'], where: { merchantId }, _sum: { amountUSDT: true } });
    const balances = { incoming: 0, pending: 0, reserve: 0, available: 0 };
    ledgers.forEach(l => { const key = l.status.toLowerCase(); if (key in balances) (balances as any)[key] = Number(l._sum.amountUSDT) || 0; });
    res.json({ success: true, data: { balances } });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const getTransactions = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = req.merchantId!;
    const txs = await prisma.transaction.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take: 10, include: { store: { select: { name: true } } } });
    const formatted = txs.map(tx => ({ id: tx.id, amount: Number(tx.amountUSDT), fiatAmount: Number(tx.amountFiat), fiatCurrency: tx.currency, status: tx.status, createdAt: tx.createdAt, store: tx.store }));
    res.json({ success: true, data: formatted });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const getWallets = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = req.merchantId!;
    const ledgers = await prisma.ledger.aggregate({ where: { merchantId, status: 'AVAILABLE' }, _sum: { amountUSDT: true } });
    res.json({ success: true, data: [ { id: 'wallet_main_usdt', currency: 'USDT', balance: Number(ledgers._sum.amountUSDT) || 0, network: 'TRC20', status: 'ACTIVE' } ] });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const depositWallet = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = req.merchantId!;
    const { amount, currency } = req.body;
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ success: false });

    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, include: { feeProfile: true } });
    if (!merchant) return res.status(404).json({ success: false });

    const rates = await FXService.getRates();
    const exchangeRate = (rates as any)[currency.toUpperCase()] || 1.0;
    const amountUSDT = amountNum * exchangeRate;

    const feePercent = FeeService.calculateInboundFee('DEPOSIT', currency, merchant.feeProfile, merchant.customFeePercent ? Number(merchant.customFeePercent) : null);
    const feeUSDT = amountUSDT * (feePercent / 100);
    const netAmountUSDT = amountUSDT - feeUSDT;

    const customer = await prisma.customer.upsert({
      where: { merchantId_email: { merchantId: merchant.id, email: merchant.email } },
      update: {}, create: { merchantId: merchant.id, email: merchant.email, name: merchant.name }
    });

    const tx = await prisma.transaction.create({
      data: { merchantId: merchant.id, customerId: customer.id, type: 'DEPOSIT', merchantName: merchant.name, amountFiat: amountNum, currency, exchangeRate, amountUSDT, feeUSDT, netAmountUSDT, status: 'PENDING_GATEWAY', customerEmail: merchant.email }
    });

    const gatewayResponse = await GatewayRouter.routePayment(currency, tx.id, amountNum, { fullName: merchant.name, email: merchant.email, taxId: null }, 'Top-up Wallet XPayments');
    await prisma.transaction.update({ where: { id: tx.id }, data: { providerUsed: gatewayResponse.gateway, providerTxId: gatewayResponse.providerTxId } });

    res.json({ success: true, data: { gateway: gatewayResponse.gateway, checkoutData: { ...gatewayResponse, providerTxId: tx.id } } });
  } catch (error: any) { res.status(500).json({ success: false }); }
};
