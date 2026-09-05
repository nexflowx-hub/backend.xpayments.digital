import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const INTERNAL_CHARGE_URL =
  process.env.XPAYMENTS_INTERNAL_CHARGE_URL ||
  'http://127.0.0.1:3001/api/v1/payments/charge';

const normaliseMethod = (value: unknown): string => {
  const method = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
  return method === 'mbway' ? 'mb_way' : method;
};

export type CheckoutOrchestratorInput = {
  storeId: string;
  environment: 'live' | 'test';
  amountMinor: number;
  currency: string;
  reference: string;
  paymentMethod: string;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  returnUrl?: string;
  paymentMethodOptions?: Record<string, unknown>;
  checkoutSessionId: string;
};

export async function executeCheckoutOrchestratedPayment(
  input: CheckoutOrchestratorInput
) {
  const keys = await prisma.apiKey.findMany({
    where: {
      storeId: input.storeId,
      environment: input.environment
    },
    orderBy: { createdAt: 'desc' }
  });

  const keyRecord = keys.find((key: any) =>
    Array.isArray(key.scopes) && key.scopes.includes('payments_write')
  );

  if (!keyRecord) {
    throw new Error(
      `CHECKOUT_PAYMENTS_WRITE_KEY_MISSING:${input.storeId}:${input.environment}`
    );
  }

  const method = normaliseMethod(input.paymentMethod);

  const body: Record<string, unknown> = {
    amount: input.amountMinor,
    currency: input.currency.toUpperCase(),
    payment_method_types: [method],
    reference: input.reference,
    customer: input.customer || {},
    metadata: {
      order_id: input.reference,
      checkout_session_id: input.checkoutSessionId,
      ...(input.returnUrl ? { return_url: input.returnUrl } : {})
    },
    ...(input.paymentMethodOptions
      ? { payment_method_options: input.paymentMethodOptions }
      : {})
  };

  const response = await fetch(INTERNAL_CHARGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${keyRecord.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const raw = await response.json().catch(() => ({}));

  if (!response.ok || raw?.success === false) {
    const message =
      raw?.error?.message ||
      raw?.message ||
      `Checkout orchestrator HTTP ${response.status}`;
    const code = raw?.error?.code || 'CHECKOUT_ORCHESTRATOR_ERROR';
    const error = new Error(message) as Error & { code?: string; status?: number };
    error.code = code;
    error.status = response.status;
    throw error;
  }

  return raw;
}
