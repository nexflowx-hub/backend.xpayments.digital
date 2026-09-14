import { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const round = (value: number): number =>
  Number(value.toFixed(2));

const dateKey = (date: Date): string =>
  date.toISOString().slice(0, 10);

type PhysicalWalletRow = {
  id: string;
  code: string;
  label: string;
  currency: string;
  wallet_role: string;
  ecosystem: string | null;
  status: string;
  balance: unknown;
  available: unknown;
  reserved: unknown;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export const getTreasuryOverview = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId =
      req.merchantId ||
      req.user?.id;

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

    const [wallets, movements, physicalWalletRows] = await Promise.all([
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
      }),

      prisma.$queryRaw<PhysicalWalletRow[]>(
        Prisma.sql`
          SELECT
            id,
            code,
            label,
            currency,
            wallet_role,
            ecosystem,
            status,
            balance,
            available,
            reserved,
            metadata,
            created_at,
            updated_at
          FROM public.treasury_wallets
          WHERE merchant_id = ${merchantId}::uuid
          ORDER BY
            CASE wallet_role
              WHEN 'BANK_SETTLEMENT' THEN 1
              WHEN 'CRYPTO_SETTLEMENT' THEN 2
              WHEN 'BLOCKED' THEN 3
              ELSE 9
            END,
            currency,
            code
        `
      )
    ]);

    /*
     * Legacy aggregate retained for compatibility only.
     * It must not be used as a cross-currency financial total because
     * wallet balances may be denominated in different currencies.
     */
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

    const physicalWallets = physicalWalletRows.map(wallet => ({
      id: wallet.id,
      code: wallet.code,
      label: wallet.label,
      currency: wallet.currency,
      role: wallet.wallet_role,
      ecosystem: wallet.ecosystem,
      status: wallet.status,
      balance: round(Number(wallet.balance)),
      available: round(Number(wallet.available)),
      reserved: round(Number(wallet.reserved)),
      physical: true,
      manualSettlement:
        wallet.metadata?.manualSettlement === true,
      autoFx:
        wallet.metadata?.autoFx === true,
      updatedAt:
        wallet.updated_at instanceof Date
          ? wallet.updated_at.toISOString()
          : String(wallet.updated_at)
    }));

    const accountingByCurrency = wallets.map(wallet => ({
      currency: wallet.currency,
      balance: round(Number(wallet.balance)),
      available: round(Number(wallet.available)),
      reserved: round(Number(wallet.reserved)),
      reconciliationHold: round(
        Number(
          (wallet as typeof wallet & {
            reconciliationHold?: unknown;
          }).reconciliationHold ?? 0
        )
      )
    }));

    const liquidityChange = 0;

    const data = {
      /*
       * Compatibility fields. These legacy totals can span multiple
       * currencies and must not be treated as a converted financial total.
       */
      totalLiquidity: round(totalLiquidity),
      reserve: round(reserve),
      pendingPayouts: round(pendingPayouts),
      netFlow: round(netFlow),
      liquidityChange,
      cashFlowSeries,
      settlementSeries,
      balances,

      /* Canonical currency-scoped / treasury data. */
      accountingByCurrency,
      physicalWallets,
      financialMetrics: 'currency_scoped',
      legacyCrossCurrencyTotalsDeprecated: true,
      generatedAt: new Date().toISOString()
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
