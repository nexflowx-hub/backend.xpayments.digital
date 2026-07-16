import { Prisma } from '@prisma/client';
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

const formatTransaction = (transaction: any) => ({
  ...transaction,
  customer: transaction.customer || transaction.customerEmail || '',
  amount: Number(transaction.amount),
  amountEur:
    transaction.amountEur !== null && transaction.amountEur !== undefined
      ? Number(transaction.amountEur)
      : Number(transaction.amount),
  fee:
    transaction.fee !== null && transaction.fee !== undefined
      ? Number(transaction.fee)
      : 0,
  riskScore: Number(transaction.riskScore ?? 0),
  events: [],
  createdAt: transaction.createdAt.toISOString()
});

export const listTransactions = async (
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

    const page = Math.max(1, Number(req.query.page ?? 1));

    const requestedLimit = Number(
      req.query.limit ?? req.query.pageSize ?? 20
    );

    const limit = Math.min(
      100,
      Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20)
    );

    const skip = (page - 1) * limit;

    const status = String(req.query.status ?? '').trim();
    const gateway = String(req.query.gateway ?? '').trim();
    const currency = String(req.query.currency ?? '').trim();
    const method = String(req.query.method ?? '').trim();
    const country = String(req.query.country ?? '').trim();

    const search = String(
      req.query.search ?? req.query.reference ?? ''
    ).trim();

    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();

    const where: Prisma.TransactionWhereInput = {
      merchantId
    };

    if (status && status !== 'all') {
      where.status = {
        equals: status,
        mode: 'insensitive'
      };
    }

    if (gateway && gateway !== 'all') {
      where.gateway = {
        equals: gateway,
        mode: 'insensitive'
      };
    }

    if (currency && currency !== 'all') {
      where.currency = currency.toUpperCase();
    }

    if (method && method !== 'all') {
      where.method = {
        equals: method,
        mode: 'insensitive'
      };
    }

    if (country && country !== 'all') {
      where.country = {
        equals: country,
        mode: 'insensitive'
      };
    }

    if (search) {
      where.OR = [
        {
          reference: {
            contains: search,
            mode: 'insensitive'
          }
        },
        {
          customer: {
            contains: search,
            mode: 'insensitive'
          }
        },
        {
          customerEmail: {
            contains: search,
            mode: 'insensitive'
          }
        }
      ];
    }

    if (from || to) {
      where.createdAt = {};

      if (from) {
        const fromDate = new Date(from);

        if (!Number.isNaN(fromDate.getTime())) {
          where.createdAt.gte = fromDate;
        }
      }

      if (to) {
        const toDate = new Date(to);

        if (!Number.isNaN(toDate.getTime())) {
          toDate.setHours(23, 59, 59, 999);
          where.createdAt.lte = toDate;
        }
      }
    }

    const sortDir =
      String(req.query.sortDir ?? 'desc').toLowerCase() === 'asc'
        ? 'asc'
        : 'desc';

    const allowedSortFields = new Set([
      'createdAt',
      'amount',
      'status',
      'reference'
    ]);

    const requestedSort = String(req.query.sortBy ?? 'createdAt');

    const sortBy = allowedSortFields.has(requestedSort)
      ? requestedSort
      : 'createdAt';

    const [items, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: {
          [sortBy]: sortDir
        },
        skip,
        take: limit
      }),

      prisma.transaction.count({
        where
      })
    ]);

    const paginated = {
      data: items.map(formatTransaction),
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      total,
      page,
      pageSize: limit
    };

    return res.status(200).json({
      success: true,
      data: paginated
    });
  } catch (error) {
    console.error('[TRANSACTIONS_LIST_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'TRANSACTIONS_ERROR',
        message: 'Erro ao listar transações.'
      }
    });
  }
};

export const getTransactionStats = async (
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

    const transactions = await prisma.transaction.findMany({
      where: {
        merchantId
      },
      select: {
        status: true,
        amount: true
      }
    });

    const total = transactions.length;

    const approved = transactions.filter(transaction =>
      successfulStatuses.includes(transaction.status.toLowerCase())
    ).length;

    const failed = transactions.filter(
      transaction => transaction.status.toLowerCase() === 'failed'
    ).length;

    const pending = transactions.filter(transaction =>
      ['pending', 'authorized', 'processing'].includes(
        transaction.status.toLowerCase()
      )
    ).length;

    const volume = transactions
      .filter(transaction =>
        successfulStatuses.includes(transaction.status.toLowerCase())
      )
      .reduce(
        (sum, transaction) => sum + Number(transaction.amount),
        0
      );

    const stats = {
      total,
      approved,
      failed,
      pending,
      successRate: total > 0 ? (approved / total) * 100 : 0,
      volume
    };

    return res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('[TRANSACTIONS_STATS_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'TRANSACTIONS_STATS_ERROR',
        message: 'Erro ao calcular estatísticas.'
      }
    });
  }
};

export const getTransaction = async (
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

    const transactionId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : String(req.params.id);

    const transaction = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        merchantId
      }
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Transação não encontrada.'
        }
      });
    }

    const formatted = formatTransaction(transaction);

    formatted.events = [
      {
        id: `${transaction.id}-created`,
        type: 'created',
        label: 'Transação criada',
        createdAt: transaction.createdAt.toISOString()
      },
      {
        id: `${transaction.id}-${transaction.status}`,
        type: transaction.status.toLowerCase(),
        label: `Estado: ${transaction.status}`,
        createdAt: transaction.createdAt.toISOString()
      }
    ];

    return res.status(200).json({
      success: true,
      data: formatted
    });
  } catch (error) {
    console.error('[TRANSACTION_DETAIL_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'TRANSACTION_DETAIL_ERROR',
        message: 'Erro ao carregar transação.'
      }
    });
  }
};
