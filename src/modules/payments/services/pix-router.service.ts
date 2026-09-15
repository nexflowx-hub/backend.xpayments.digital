import { PrismaClient } from '@prisma/client';

import {
  executePixPayment as executeLegacyPixPayment,
  ExecutePixPaymentInput,
  PixPaymentError
} from './misticpay.service';

import {
  executePixD1Payment
} from './pixgo.service';

const prisma = new PrismaClient();

const asRecord = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return {};
};

const parseRoutingRules = (value: unknown): Record<string, string> => {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    return asRecord(value) as Record<string, string>;
  } catch {
    return {};
  }
};

export const executeRoutedPixPayment = async (
  input: ExecutePixPaymentInput
) => {
  const store = await prisma.store.findUnique({
    where: { id: input.storeId }
  });

  if (!store || store.status !== 'active') {
    throw new PixPaymentError(
      'STORE_INACTIVE',
      401,
      'Acesso negado.'
    );
  }

  const targetProvider = String(
    parseRoutingRules(store.routingRules).pix ?? ''
  )
    .trim()
    .toLowerCase();

  if (!targetProvider) {
    throw new PixPaymentError(
      'PIX_ROUTING_NOT_CONFIGURED',
      500,
      'Roteamento PIX não configurado.'
    );
  }

  if (targetProvider.startsWith('pix-d1')) {
    return executePixD1Payment(input);
  }

  return executeLegacyPixPayment(input);
};
