import { PrismaClient } from '@prisma/client';

import {
  ExecutePixPaymentInput,
  PixPaymentError
} from './misticpay.service';

const prisma = new PrismaClient();

const DEFAULT_BASE_URL = 'https://pixgo.org/api/v1';
const PIX_WEBHOOK_URL =
  'https://api.xpayments.digital/api/v1/payments/webhooks/pix-d1';
const MAX_QR_IMAGE_BYTES = 256 * 1024;

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

const onlyDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

const isRepeatedDigits = (value: string) => /^(\d)\1+$/.test(value);

const isValidCpf = (cpf: string) => {
  if (!/^\d{11}$/.test(cpf) || isRepeatedDigits(cpf)) return false;

  const calc = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      sum += Number(cpf[i]) * (length + 1 - i);
    }
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
};

const isValidCnpj = (cnpj: string) => {
  if (!/^\d{14}$/.test(cnpj) || isRepeatedDigits(cnpj)) return false;

  const calc = (base: string, weights: number[]) => {
    const sum = base
      .split('')
      .reduce((acc, digit, index) => acc + Number(digit) * weights[index], 0);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const d1 = calc(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(`${cnpj.slice(0, 12)}${d1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
};

const isValidTaxId = (value: string) => isValidCpf(value) || isValidCnpj(value);

export const getPixD1Credentials = (credentialsValue: unknown) => {
  const credentials = asRecord(credentialsValue);
  const apiKey = String(credentials.apiKey ?? credentials.api_key ?? '').trim();
  const webhookSecret = String(
    credentials.webhookSecret ?? credentials.webhook_secret ?? ''
  ).trim();
  const baseUrl = String(credentials.baseUrl ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/$/, '');

  if (!apiKey) {
    throw new PixPaymentError(
      'PIX_GATEWAY_NOT_CONFIGURED',
      500,
      'Gateway PIX não configurado.'
    );
  }

  return { apiKey, webhookSecret, baseUrl };
};

class ProviderHttpError extends Error {
  constructor(
    public statusCode: number,
    public providerCode: string | null,
    public providerMessage: string | null
  ) {
    super(providerMessage || `Provider HTTP ${statusCode}`);
    this.name = 'ProviderHttpError';
  }
}

const providerRequest = async (
  credentialsValue: unknown,
  method: 'GET' | 'POST',
  path: string,
  payload?: Record<string, unknown>,
  acceptedStatuses: number[] = [200, 201]
) => {
  const { apiKey, baseUrl } = getPixD1Credentials(credentialsValue);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': apiKey,
        ...(payload ? { 'Content-Type': 'application/json' } : {})
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    console.error('[PIX-D1 PROVIDER NETWORK ERROR]', {
      path,
      message: error instanceof Error ? error.message : 'unknown'
    });
    throw new PixPaymentError(
      'PIX_PROVIDER_UNAVAILABLE',
      502,
      'Serviço PIX temporariamente indisponível.'
    );
  }

  const body: any = await response.json().catch(() => ({}));

  if (!acceptedStatuses.includes(response.status)) {
    console.error('[PIX-D1 PROVIDER HTTP ERROR]', {
      path,
      status: response.status,
      code: body?.error ?? null
    });
    throw new ProviderHttpError(
      response.status,
      body?.error ? String(body.error) : null,
      body?.message ? String(body.message) : null
    );
  }

  return body;
};

export const checkPixD1PaymentStatus = async (
  credentialsValue: unknown,
  paymentId: string
) => providerRequest(
  credentialsValue,
  'GET',
  `/payment/${encodeURIComponent(paymentId)}/status`,
  undefined,
  [200]
);

export const getPixD1Payment = async (
  credentialsValue: unknown,
  paymentId: string
) => providerRequest(
  credentialsValue,
  'GET',
  `/payment/${encodeURIComponent(paymentId)}`,
  undefined,
  [200, 410]
);

const findByExternalId = async (
  credentialsValue: unknown,
  externalId: string
) => {
  const result = await providerRequest(
    credentialsValue,
    'GET',
    `/payments?external_id=${encodeURIComponent(externalId)}&limit=20&offset=0`,
    undefined,
    [200]
  );

  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.find((row: any) => String(row?.external_id ?? '') === externalId) ?? null;
};

const fetchQrImageAsDataUrl = async (url: unknown): Promise<string | null> => {
  const value = String(url ?? '').trim();
  if (!value.startsWith('https://')) return null;

  try {
    const response = await fetch(value, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;

    const contentType = String(response.headers.get('content-type') ?? 'image/png')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith('image/')) return null;

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_QR_IMAGE_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_QR_IMAGE_BYTES) return null;

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
};

const normalizeProviderPayment = async (providerDataValue: unknown) => {
  const providerData = asRecord(providerDataValue);
  const paymentId = String(providerData.payment_id ?? '').trim();
  const copyPaste = String(providerData.qr_code ?? '').trim();

  if (!paymentId || !copyPaste) {
    throw new PixPaymentError(
      'PIX_INVALID_PROVIDER_RESPONSE',
      502,
      'Resposta PIX inválida.'
    );
  }

  const qrCodeBase64 = await fetchQrImageAsDataUrl(providerData.qr_image_url);

  return {
    paymentId,
    copyPaste,
    qrCodeBase64,
    expiresAt: providerData.expires_at ?? null,
    createdAt: providerData.created_at ?? null,
    providerStatus: String(providerData.status ?? 'pending').toLowerCase()
  };
};

const publicResult = (
  transactionId: string,
  reference: string,
  pix: {
    copyPaste: string;
    qrCodeBase64?: string | null;
    expiresAt?: unknown;
  }
) => ({
  transactionId,
  reference,
  status: 'pending',
  method: 'pix',
  action: {
    type: 'pix',
    copyPaste: pix.copyPaste,
    pixString: pix.copyPaste,
    qrCode: pix.qrCodeBase64 ?? null,
    qrCodeBase64: pix.qrCodeBase64 ?? null,
    qrCodeUrl: null,
    expiresAt: pix.expiresAt ?? null
  }
});

export const executePixD1Payment = async (
  input: ExecutePixPaymentInput
) => {
  const amountInCents = Number(input.amount);
  if (!Number.isInteger(amountInCents) || amountInCents < 1000) {
    throw new PixPaymentError(
      'PIX_AMOUNT_OUT_OF_RANGE',
      400,
      'O valor mínimo para PIX é R$ 10,00.'
    );
  }

  const currency = String(input.currency || '').trim().toUpperCase();
  if (currency !== 'BRL') {
    throw new PixPaymentError(
      'PIX_BRL_REQUIRED',
      400,
      'PIX aceita apenas pagamentos em BRL.'
    );
  }

  const store = await prisma.store.findUnique({ where: { id: input.storeId } });
  if (!store || store.status !== 'active') {
    throw new PixPaymentError('STORE_INACTIVE', 401, 'Acesso negado.');
  }
  if (String(store.currency).toUpperCase() !== 'BRL') {
    throw new PixPaymentError(
      'STORE_CURRENCY_MISMATCH',
      409,
      'Store não configurada para BRL.'
    );
  }

  const targetProvider = String(parseRoutingRules(store.routingRules).pix ?? '')
    .trim()
    .toLowerCase();
  if (!targetProvider.startsWith('pix-d1')) {
    throw new PixPaymentError(
      'PIX_ROUTING_NOT_CONFIGURED',
      500,
      'Roteamento PIX não configurado.'
    );
  }

  const vaults = await prisma.gatewayVault.findMany({
    where: {
      merchantId: store.merchantId,
      isActive: true,
      OR: [{ storeId: null }, { storeId: store.id }]
    }
  });
  const gatewayVault = vaults.find(
    vault => vault.provider.toLowerCase() === targetProvider
  );
  if (!gatewayVault) {
    throw new PixPaymentError(
      'PIX_GATEWAY_NOT_CONFIGURED',
      500,
      'Gateway PIX não configurado.'
    );
  }
  getPixD1Credentials(gatewayVault.credentials);

  const customer = input.customer || {};
  const metadata = input.metadata || {};
  const payerName = String(
    customer.name ?? customer.fullName ?? metadata.payerName ?? ''
  ).trim();
  const payerDocument = onlyDigits(
    customer.document ??
      customer.cpf ??
      customer.taxId ??
      customer.tax_id ??
      metadata.payerDocument ??
      metadata.cpf
  );

  if (!isValidTaxId(payerDocument)) {
    throw new PixPaymentError(
      'PIX_PAYER_DOCUMENT_REQUIRED',
      400,
      'Informe CPF ou CNPJ válido para PIX.'
    );
  }

  const email = String(customer.email ?? '').trim();
  const phone = onlyDigits(customer.phone ?? metadata.phone);
  const address = String(
    (customer as any).address ?? metadata.address ?? ''
  ).trim();
  const reference = String(input.merchantReference || `PIX-${Date.now()}`).trim();

  let transaction = await prisma.transaction.findFirst({
    where: { merchantId: store.merchantId, reference }
  });

  if (transaction?.status === 'succeeded') {
    throw new PixPaymentError(
      'TRANSACTION_ALREADY_PAID',
      409,
      'Transação já paga.'
    );
  }

  if (transaction?.providerId && transaction.status === 'pending') {
    const previousPix = asRecord(asRecord(transaction.rawResponse).pix);
    if (previousPix.copyPaste) {
      return publicResult(transaction.id, reference, {
        copyPaste: String(previousPix.copyPaste),
        qrCodeBase64: previousPix.qrCodeBase64 ?? null,
        expiresAt: previousPix.expiresAt ?? null
      });
    }
  }

  const safeRawRequest = {
    amount: amountInCents,
    currency: 'BRL',
    payment_method_types: ['pix'],
    reference,
    customer: {
      name: payerName || null,
      email: email || null,
      documentLast4: payerDocument.slice(-4)
    }
  };

  if (transaction) {
    transaction = await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        storeId: store.id,
        gatewayVaultId: gatewayVault.id,
        amount: amountInCents / 100,
        currency: 'BRL',
        status: 'pending',
        method: 'pix',
        gateway: 'pix',
        customer: payerName || null,
        customerEmail: email || null,
        rawRequest: safeRawRequest
      }
    });
  } else {
    transaction = await prisma.transaction.create({
      data: {
        merchantId: store.merchantId,
        storeId: store.id,
        gatewayVaultId: gatewayVault.id,
        reference,
        amount: amountInCents / 100,
        currency: 'BRL',
        status: 'pending',
        method: 'pix',
        gateway: 'pix',
        customer: payerName || null,
        customerEmail: email || null,
        rawRequest: safeRawRequest
      }
    });
  }

  const externalId = transaction.id;
  let providerData: any = null;

  try {
    providerData = await findByExternalId(gatewayVault.credentials, externalId);
  } catch {
    // A busca de recuperação é best-effort; a criação continua normalmente.
  }

  if (!providerData) {
    const payload: Record<string, unknown> = {
      amount: Number((amountInCents / 100).toFixed(2)),
      receiver_cpf: payerDocument,
      external_id: externalId,
      description: String(
        metadata.description ?? `Pagamento ${reference}`
      ).slice(0, 200),
      webhook_url: PIX_WEBHOOK_URL
    };

    if (payerName) payload.receiver_name = payerName.slice(0, 100);
    if (email) payload.receiver_email = email.slice(0, 255);
    if (phone.length === 10 || phone.length === 11) payload.receiver_phone = phone;
    if (address.length >= 10) payload.receiver_address = address.slice(0, 500);

    try {
      const created = await providerRequest(
        gatewayVault.credentials,
        'POST',
        '/payment/create',
        payload,
        [201]
      );
      providerData = created?.data;
    } catch (error) {
      // Como o provider não documenta Idempotency-Key, uma falha de rede após
      // o POST pode ter criado a cobrança. Recuperamos por external_id.
      try {
        providerData = await findByExternalId(gatewayVault.credentials, externalId);
      } catch {
        providerData = null;
      }

      if (!providerData) {
        if (error instanceof ProviderHttpError && error.statusCode >= 400 && error.statusCode < 500) {
          await prisma.transaction.update({
            where: { id: transaction.id },
            data: {
              status: 'failed',
              rawResponse: {
                state: 'provider_rejected',
                code: error.providerCode
              }
            }
          }).catch(() => undefined);

          throw new PixPaymentError(
            'PIX_PROVIDER_REJECTED',
            400,
            error.providerMessage || 'Não foi possível gerar o PIX.'
          );
        }

        await prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            rawResponse: {
              state: 'reconciliation_required',
              externalId
            }
          }
        }).catch(() => undefined);

        if (error instanceof PixPaymentError) throw error;
        throw new PixPaymentError(
          'PIX_PROVIDER_UNAVAILABLE',
          502,
          'Serviço PIX temporariamente indisponível.'
        );
      }
    }
  }

  const normalized = await normalizeProviderPayment(providerData);
  const safeProviderResponse = {
    state: normalized.providerStatus,
    pix: {
      copyPaste: normalized.copyPaste,
      qrCodeBase64: normalized.qrCodeBase64,
      expiresAt: normalized.expiresAt
    },
    settlement: {
      status: 'awaiting_payment',
      mode: 'D1',
      asset: 'DEPIX',
      network: 'LIQUID'
    },
    createdAt: normalized.createdAt
  };

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: {
      providerId: normalized.paymentId,
      status: 'pending',
      rawResponse: safeProviderResponse
    }
  });

  console.log('[PIX CREATED]', {
    transactionId: transaction.id,
    reference,
    amount: amountInCents / 100,
    currency: 'BRL',
    storeId: store.id,
    rail: 'd1'
  });

  return publicResult(transaction.id, reference, normalized);
};
