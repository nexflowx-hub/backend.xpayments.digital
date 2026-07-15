import { Response } from 'express';

import prisma from '../../../core/prisma';
import { serializeResponse } from '../../../core/utils/api-formatters';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const getTransactions = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: [],
    meta: {
      page: 1,
      limit: 10,
      total: 0,
      pages: 0
    }
  });
};

export const getStores = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const getProducts = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const createProduct = async (req: AuthRequest, res: Response) => {
  return res.status(201).json({
    success: true,
    data: {
      id: 'stub-id',
      ...req.body
    }
  });
};

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    message: 'Produto removido com sucesso'
  });
};

export const getPaymentLinks = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const getInvoices = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const getSubscriptions = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const getCustomers = async (req: AuthRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

export const getWebhooks = async (req: AuthRequest, res: Response) => {

  const stores = await prisma.store.findMany({
    where: {
      merchantId: req.user.id
    },
    select: {
      id: true
    }
  });

  const hooks = await prisma.webhook.findMany({
    where: {
      storeId: {
        in: stores.map(store => store.id)
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  return res.status(200).json({
    success: true,
    data: serializeResponse(hooks)
  });

};
