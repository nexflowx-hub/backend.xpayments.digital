import { Response } from 'express';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const successfulStatuses = [
  'approved',
  'succeeded',
  'paid',
  'captured',
  'completed'
];

const round = (value: number): number =>
  Number(value.toFixed(2));

const isSuccessful = (status: string): boolean =>
  successfulStatuses.includes(status.toLowerCase());

const percentageChange = (
  current: number,
  previous: number
): number => {
  if (previous === 0) {
    return 0;
  }

  return round(((current - previous) / previous) * 100);
};

const formatTransaction = (transaction: any) => ({
  id: transaction.id,
  reference: transaction.reference,
  customer:
    transaction.customer || transaction.customerEmail || '',
  customerEmail: transaction.customerEmail || '',
  amount: Number(transaction.amount),
  amountEur:
    transaction.amountEur !== null &&
    transaction.amountEur !== undefined
      ? Number(transaction.amountEur)
      : Number(transaction.amount),
  currency: transaction.currency,
  status: transaction.status.toLowerCase(),
  method: transaction.method,
  country: transaction.country || '',
  gateway: transaction.gateway || '',
  riskScore: Number(transaction.riskScore ?? 0),
  fee:
    transaction.fee !== null && transaction.fee !== undefined
      ? Number(transaction.fee)
      : 0,
  metadata: transaction.metadata ?? {},
  events: [],
  createdAt: transaction.createdAt.toISOString()
});

export const getOverview = async (
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

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1
    );

    const startOfPreviousMonth = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1
    );

    const startOfSeries = new Date(now);
    startOfSeries.setDate(startOfSeries.getDate() - 29);
    startOfSeries.setHours(0, 0, 0, 0);

    const [
      merchant,
      wallets,
      transactions,
      customers
    ] = await Promise.all([
      prisma.merchant.findUnique({
        where: {
          id: merchantId
        },
        select: {
          riskScore: true
        }
      }),

      prisma.wallet.findMany({
        where: {
          merchantId
        }
      }),

      prisma.transaction.findMany({
        where: {
          merchantId
        },
        orderBy: {
          createdAt: 'desc'
        }
      }),

      prisma.customer.findMany({
        where: {
          merchantId
        },
        orderBy: {
          ltv: 'desc'
        },
        take: 5
      })
    ]);

    const successfulTransactions = transactions.filter(transaction =>
      isSuccessful(transaction.status)
    );

    const todayTransactions = transactions.filter(
      transaction => transaction.createdAt >= startOfToday
    );

    const monthTransactions = transactions.filter(
      transaction => transaction.createdAt >= startOfMonth
    );

    const previousMonthTransactions = transactions.filter(
      transaction =>
        transaction.createdAt >= startOfPreviousMonth &&
        transaction.createdAt < startOfMonth
    );

    const monthSuccessful = monthTransactions.filter(transaction =>
      isSuccessful(transaction.status)
    );

    const previousMonthSuccessful =
      previousMonthTransactions.filter(transaction =>
        isSuccessful(transaction.status)
      );

    const calculateVolume = (items: typeof transactions): number =>
      items
        .filter(transaction => isSuccessful(transaction.status))
        .reduce(
          (sum, transaction) =>
            sum +
            Number(
              transaction.amountEur ??
              transaction.amount
            ),
          0
        );

    const totalVolume = calculateVolume(transactions);
    const monthVolume = calculateVolume(monthTransactions);
    const previousMonthVolume =
      calculateVolume(previousMonthTransactions);

    const todayVolume = calculateVolume(todayTransactions);

    const totalFees = successfulTransactions.reduce(
      (sum, transaction) => sum + Number(transaction.fee ?? 0),
      0
    );

    const revenue = round(totalFees > 0 ? totalFees : totalVolume);

    const previousRevenue = round(
      previousMonthSuccessful.reduce(
        (sum, transaction) =>
          sum + Number(transaction.fee ?? transaction.amountEur ?? 0),
        0
      )
    );

    const approvalRate =
      transactions.length > 0
        ? round(
            (successfulTransactions.length / transactions.length) *
              100
          )
        : 0;

    const conversion = approvalRate;

    const seriesMap = new Map<
      string,
      { revenue: number; volume: number }
    >();

    for (let index = 0; index < 30; index += 1) {
      const day = new Date(startOfSeries);
      day.setDate(startOfSeries.getDate() + index);

      seriesMap.set(day.toISOString().slice(0, 10), {
        revenue: 0,
        volume: 0
      });
    }

    for (const transaction of transactions) {
      if (!isSuccessful(transaction.status)) {
        continue;
      }

      const key = transaction.createdAt
        .toISOString()
        .slice(0, 10);

      const entry = seriesMap.get(key);

      if (!entry) {
        continue;
      }

      const transactionVolume = Number(
        transaction.amountEur ?? transaction.amount
      );

      entry.volume += transactionVolume;
      entry.revenue += Number(
        transaction.fee ?? transactionVolume
      );
    }

    const revenueSeries = Array.from(
      seriesMap.entries()
    ).map(([date, values]) => ({
      date,
      value: round(values.revenue)
    }));

    const volumeSeries = Array.from(
      seriesMap.entries()
    ).map(([date, values]) => ({
      date,
      value: round(values.volume)
    }));

    const methodMap = new Map<
      string,
      { count: number; volume: number }
    >();

    const currencyMap = new Map<
      string,
      { count: number; volume: number }
    >();

    for (const transaction of successfulTransactions) {
      const amount = Number(
        transaction.amountEur ?? transaction.amount
      );

      const method = transaction.method || 'unknown';

      const methodEntry = methodMap.get(method) ?? {
        count: 0,
        volume: 0
      };

      methodEntry.count += 1;
      methodEntry.volume += amount;
      methodMap.set(method, methodEntry);

      const currency = transaction.currency || 'EUR';

      const currencyEntry = currencyMap.get(currency) ?? {
        count: 0,
        volume: 0
      };

      currencyEntry.count += 1;
      currencyEntry.volume += amount;
      currencyMap.set(currency, currencyEntry);
    }

    const paymentMethods = Array.from(
      methodMap.entries()
    ).map(([method, values]) => ({
      method,
      share:
        successfulTransactions.length > 0
          ? round(
              (values.count / successfulTransactions.length) * 100
            )
          : 0,
      volume: round(values.volume)
    }));

    const currencies = Array.from(
      currencyMap.entries()
    ).map(([currency, values]) => ({
      currency,
      share:
        successfulTransactions.length > 0
          ? round(
              (values.count / successfulTransactions.length) * 100
            )
          : 0,
      volume: round(values.volume)
    }));

    const topCustomers = customers.map(customer => ({
      name: customer.name || customer.email || 'Cliente',
      ltv: Number(customer.ltv),
      orders: customer.orders
    }));

    const realtime = transactions.slice(0, 8).map(transaction => ({
      id: transaction.id,
      label:
        transaction.customer ||
        transaction.customerEmail ||
        transaction.reference,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      ago: transaction.createdAt.toISOString()
    }));

    const wallet = {
      totalBalance: round(
        wallets.reduce(
          (sum, currentWallet) =>
            sum + Number(currentWallet.balance),
          0
        )
      ),
      availableBalance: round(
        wallets.reduce(
          (sum, currentWallet) =>
            sum + Number(currentWallet.available),
          0
        )
      ),
      currencies: wallets.length
    };

    const transactionMetrics = {
      today: todayTransactions.length,
      month: monthTransactions.length,
      total: transactions.length,
      successRate: approvalRate,
      volumeToday: round(todayVolume),
      volumeMonth: round(monthVolume)
    };

    const payload = {
      wallet,
      transactions: transactionMetrics,
      recentTransactions: transactions
        .slice(0, 10)
        .map(formatTransaction),

      revenue,
      revenueChange: percentageChange(
        monthVolume,
        previousMonthVolume
      ),

      volume: round(totalVolume),
      volumeChange: percentageChange(
        monthVolume,
        previousMonthVolume
      ),

      conversion,
      conversionChange: percentageChange(
        monthSuccessful.length,
        previousMonthSuccessful.length
      ),

      approvalRate,
      approvalChange: percentageChange(
        monthSuccessful.length,
        previousMonthSuccessful.length
      ),

      riskScore: Number(merchant?.riskScore ?? 0),
      riskChange: 0,

      revenueSeries,
      volumeSeries,
      paymentMethods,

      currencies,
      currencies_dist: currencies,

      topCustomers,
      realtime
    };

    return res.status(200).json({
      success: true,
      data: payload
    });
  } catch (error) {
    console.error('[ANALYTICS_OVERVIEW_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'ANALYTICS_ERROR',
        message: 'Erro ao carregar analytics.'
      }
    });
  }
};
