import { Response } from 'express';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const getMerchantId = (req: AuthRequest): string | null =>
  req.user?.id ? String(req.user.id) : null;

const unauthorized = (res: Response) =>
  res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Merchant não autenticado.'
    }
  });

export const getTransactions = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit ?? 20))
    );

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          merchantId
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip: (page - 1) * limit,
        take: limit
      }),

      prisma.transaction.count({
        where: {
          merchantId
        }
      })
    ]);

    const data = transactions.map(transaction => ({
      ...transaction,
      customer:
        transaction.customer ||
        transaction.customerEmail ||
        '',
      customerEmail: transaction.customerEmail || '',
      amount: Number(transaction.amount),
      amountEur:
        transaction.amountEur !== null
          ? Number(transaction.amountEur)
          : Number(transaction.amount),
      fee:
        transaction.fee !== null
          ? Number(transaction.fee)
          : 0,
      riskScore: Number(transaction.riskScore ?? 0),
      events: [],
      createdAt: transaction.createdAt.toISOString()
    }));

    return res.status(200).json({
      success: true,
      data: {
        data,
        total,
        page,
        pageSize: limit,
        meta: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('[COMMERCE_TRANSACTIONS_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'TRANSACTIONS_ERROR',
        message: 'Erro ao carregar transações.'
      }
    });
  }
};

export const getStores = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const stores = await prisma.store.findMany({
      where: {
        merchantId
      },
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        _count: {
          select: {
            transactions: true,
            apiKeys: true,
            webhooks: true,
            checkoutSessions: true,
            gatewayVaults: true
          }
        }
      }
    });

    return res.status(200).json({
      success: true,
      data: stores.map(store => ({
        id: store.id,
        merchantId: store.merchantId,
        storeCode: store.storeCode,
        name: store.name,
        label: store.name,
        domain: store.domain || '',
        status: store.status,
        revenue: Number(store.revenue ?? 0),
        currency: store.currency,

        // Product ainda pertence ao Merchant no schema atual.
        products: 0,

        transactions: Number(
          store._count.transactions ?? 0
        ),
        apiKeys: Number(store._count.apiKeys ?? 0),
        webhooks: Number(store._count.webhooks ?? 0),
        checkoutSessions: Number(
          store._count.checkoutSessions ?? 0
        ),
        gateways: Number(
          store._count.gatewayVaults ?? 0
        ),

        routingRules: store.routingRules ?? {},
        logoUrl: store.logoUrl,
        theme: store.theme,
        createdAt: store.createdAt.toISOString()
      }))
    });
  } catch (error) {
    console.error('[COMMERCE_STORES_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'STORES_ERROR',
        message: 'Erro ao carregar stores.'
      }
    });
  }
};

export const getProducts = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const products = await prisma.product.findMany({
      where: {
        merchantId
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return res.status(200).json({
      success: true,
      data: products.map(product => ({
        id: product.id,
        name: product.name,
        description: product.description,
        price: Number(product.price),
        currency: product.currency,
        active: product.active,
        status: product.active ? 'active' : 'archived',
        sales: Number(product.sales ?? 0),
        stock:
          product.stock === null
            ? null
            : Number(product.stock),
        createdAt: product.createdAt.toISOString()
      }))
    });
  } catch (error) {
    console.error('[COMMERCE_PRODUCTS_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'PRODUCTS_ERROR',
        message: 'Erro ao carregar produtos.'
      }
    });
  }
};

export const createProduct = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const {
      name,
      description,
      price,
      currency,
      active,
      status,
      stock
    } = req.body;

    if (
      !name ||
      price === undefined ||
      !Number.isFinite(Number(price)) ||
      Number(price) < 0
    ) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Nome e preço válido são obrigatórios.'
        }
      });
    }

    const product = await prisma.product.create({
      data: {
        merchantId,
        name: String(name).trim(),
        description: description
          ? String(description).trim()
          : null,
        price: Number(price),
        currency: String(currency ?? 'EUR').toUpperCase(),
        active:
          typeof active === 'boolean'
            ? active
            : status !== 'archived',
        stock:
          stock === null || stock === undefined
            ? null
            : Number(stock)
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        id: product.id,
        name: product.name,
        description: product.description,
        price: Number(product.price),
        currency: product.currency,
        active: product.active,
        status: product.active ? 'active' : 'archived',
        sales: Number(product.sales ?? 0),
        stock: product.stock,
        createdAt: product.createdAt.toISOString()
      }
    });
  } catch (error) {
    console.error('[COMMERCE_PRODUCT_CREATE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'PRODUCT_CREATE_ERROR',
        message: 'Erro ao criar produto.'
      }
    });
  }
};

export const deleteProduct = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const productId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : String(req.params.id);

    const result = await prisma.product.deleteMany({
      where: {
        id: productId,
        merchantId
      }
    });

    if (result.count === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Produto não encontrado.'
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        ok: true,
        deleted: true,
        id: productId
      },
      message: 'Produto removido com sucesso.'
    });
  } catch (error) {
    console.error('[COMMERCE_PRODUCT_DELETE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'PRODUCT_DELETE_ERROR',
        message: 'Erro ao remover produto.'
      }
    });
  }
};

export const getCustomers = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const customers = await prisma.customer.findMany({
      where: {
        merchantId
      },
      orderBy: {
        lastSeen: 'desc'
      }
    });

    return res.status(200).json({
      success: true,
      data: customers.map(customer => ({
        id: customer.id,
        name: customer.name || '',
        email: customer.email || '',
        country: customer.country || '',
        ltv: Number(customer.ltv ?? 0),
        avgOrder: Number(customer.avgOrder ?? 0),
        orders: Number(customer.orders ?? 0),
        segment: customer.segment,
        status: customer.status,
        firstSeen: customer.firstSeen.toISOString(),
        lastSeen: customer.lastSeen.toISOString()
      }))
    });
  } catch (error) {
    console.error('[COMMERCE_CUSTOMERS_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'CUSTOMERS_ERROR',
        message: 'Erro ao carregar clientes.'
      }
    });
  }
};

export const getPaymentLinks = async (
  req: AuthRequest,
  res: Response
) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const getInvoices = async (
  req: AuthRequest,
  res: Response
) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const getSubscriptions = async (
  req: AuthRequest,
  res: Response
) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};
