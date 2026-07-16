import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const round = (value: number): number =>
  Number(value.toFixed(2));

const dateKey = (date: Date): string =>
  date.toISOString().slice(0, 10);

export const getTreasuryOverview = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = req.user?.id;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Merchant não autenticado.'
        }
      });
    }

    const now = new Date();
    const startDate = new Date(now);
    startDate.setUTCDate(startDate.getUTCDate() - 29);
    startDate.setUTCHours(0, 0, 0, 0);

    const [wallets, movements] = await Promise.all([
      prisma.wallet.findMany({
        where: {
          merchantId
        },
        orderBy: {
          currency: 'asc'
        }
      }),

      prisma.walletMovement.findMany({
        where: {
          merchantId,
          createdAt: {
            gte: startDate
          }
        },
        orderBy: {
          createdAt: 'asc'
        }
      })
    ]);

    const totalLiquidity = wallets.reduce(
      (sum, wallet) => sum + Number(wallet.balance),
      0
    );

    const reserve = wallets.reduce(
      (sum, wallet) => sum + Number(wallet.reserved),
      0
    );

    const pendingPayouts = movements
      .filter(
        movement =>
          movement.direction === 'out' &&
          ['pending', 'processing', 'pendente', 'em_transito'].includes(
            movement.status
          )
      )
      .reduce(
        (sum, movement) => sum + Number(movement.amount),
        0
      );

    const inflow = movements
      .filter(movement => movement.direction === 'in')
      .reduce(
        (sum, movement) => sum + Number(movement.amount),
        0
      );

    const outflow = movements
      .filter(movement => movement.direction === 'out')
      .reduce(
        (sum, movement) => sum + Number(movement.amount),
        0
      );

    const netFlow = inflow - outflow;

    const cashFlowMap = new Map<
      string,
      { inflow: number; outflow: number }
    >();

    const settlementMap = new Map<string, number>();

    for (let index = 0; index < 30; index += 1) {
      const day = new Date(startDate);
      day.setUTCDate(startDate.getUTCDate() + index);

      const key = dateKey(day);

      cashFlowMap.set(key, {
        inflow: 0,
        outflow: 0
      });

      settlementMap.set(key, 0);
    }

    for (const movement of movements) {
      const key = dateKey(movement.createdAt);
      const amount = Number(movement.amount);

      const cashFlow = cashFlowMap.get(key);

      if (cashFlow) {
        if (movement.direction === 'in') {
          cashFlow.inflow += amount;
        } else {
          cashFlow.outflow += amount;
        }
      }

      if (
        ['completed', 'concluido', 'disponivel'].includes(
          movement.status
        )
      ) {
        settlementMap.set(
          key,
          (settlementMap.get(key) ?? 0) + amount
        );
      }
    }

    const cashFlowSeries = Array.from(
      cashFlowMap.entries()
    ).map(([date, values]) => ({
      date,
      inflow: round(values.inflow),
      outflow: round(values.outflow)
    }));

    const settlementSeries = Array.from(
      settlementMap.entries()
    ).map(([date, value]) => ({
      date,
      value: round(value)
    }));

    const balances = wallets.map(wallet => ({
      currency: wallet.currency,
      amount: round(Number(wallet.balance)),
      changePct: 0
    }));

    const liquidityChange = 0;

    const data = {
      totalLiquidity: round(totalLiquidity),
      reserve: round(reserve),
      pendingPayouts: round(pendingPayouts),
      netFlow: round(netFlow),
      liquidityChange,
      cashFlowSeries,
      settlementSeries,
      balances
    };

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[TREASURY_OVERVIEW_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'TREASURY_ERROR',
        message: 'Erro ao carregar tesouraria.'
      }
    });
  }
};
