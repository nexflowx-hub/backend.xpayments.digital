import { PrismaClient } from '@prisma/client';

import {
  executePixPayment as executeLegacyPixPayment,
  ExecutePixPaymentInput,
  PixPaymentError
} from './misticpay.service';

import {
  executePixD1Payment
} from './pixgo.service';

import {
  attachPixRoutingDecision,
  resolvePixRoutingV3,
  PixRoutingV3Selection
} from './pix-routing-v3.service';

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

const observeRoutingV3 = async (
  store: { id: string; merchantId: string },
  input: ExecutePixPaymentInput
): Promise<PixRoutingV3Selection | null> => {
  try {
    return await resolvePixRoutingV3({
      storeId: store.id,
      merchantId: store.merchantId,
      amountMinor: Number(input.amount),
      environment: 'live',
      merchantReference: String(input.merchantReference || '')
    });
  } catch (error) {
    console.error('[PIX ROUTING V3 SHADOW ERROR]', {
      storeId: store.id,
      message: error instanceof Error ? error.message : 'unknown'
    });
    return null;
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

  /*
   * Routing V3 is observer-only in this rollout. The real provider remains
   * selected by the legacy Store.routingRules.pix contract until the provider
   * executors accept the selected gatewayVaultId explicitly.
   */
  const routingV3 = await observeRoutingV3(store, input);
  if (routingV3?.mode === 'enforce') {
    console.warn('[PIX ROUTING V3 ENFORCE DEFERRED]', {
      storeId: store.id,
      decisionId: routingV3.decisionId,
      selectedAlias: routingV3.selected?.alias ?? null
    });
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

  const result = targetProvider.startsWith('pix-d1')
    ? await executePixD1Payment(input)
    : await executeLegacyPixPayment(input);

  await attachPixRoutingDecision(
    routingV3?.decisionId ?? null,
    result?.transactionId ?? null
  ).catch(error => {
    console.error('[PIX ROUTING V3 ATTACH ERROR]', {
      storeId: store.id,
      decisionId: routingV3?.decisionId ?? null,
      message: error instanceof Error ? error.message : 'unknown'
    });
  });

  console.log('[PIX ROUTING OBSERVED]', {
    storeId: store.id,
    legacyProvider: targetProvider,
    routingMode: routingV3?.mode ?? 'unavailable',
    selectedAlias: routingV3?.selected?.alias ?? null,
    decisionId: routingV3?.decisionId ?? null
  });

  return result;
};
