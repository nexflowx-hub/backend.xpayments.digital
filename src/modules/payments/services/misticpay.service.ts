import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MISTICPAY_BASE_URL =
  'https://api.misticpay.com/api';

const MISTICPAY_WEBHOOK_URL =
  'https://api.xpayments.digital/api/v1/payments/webhooks/misticpay';

export class PixPaymentError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'PixPaymentError';
  }
}

const asRecord = (
  value: unknown
): Record<string, any> => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, any>;
  }

  return {};
};

const parseRoutingRules = (
  value: unknown
): Record<string, string> => {
  try {
    if (typeof value === 'string') {
      return JSON.parse(value);
    }

    return asRecord(value) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
};

const getCredentials = (
  credentialsValue: unknown
) => {
  const credentials =
    asRecord(credentialsValue);

  const ci =
    String(credentials.ci || '').trim();

  const cs =
    String(credentials.cs || '').trim();

  if (!ci || !cs) {
    throw new PixPaymentError(
      'PIX_GATEWAY_NOT_CONFIGURED',
      500,
      'Gateway PIX não configurado.'
    );
  }

  return {
    ci,
    cs
  };
};

const providerRequest = async (
  path: string,
  credentialsValue: unknown,
  payload: Record<string, unknown>
) => {
  const { ci, cs } =
    getCredentials(credentialsValue);

  let response: Response;

  try {
    response = await fetch(
      `${MISTICPAY_BASE_URL}${path}`,
      {
        method: 'POST',
        headers: {
          ci,
          cs,
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify(payload),
        signal:
          AbortSignal.timeout(15000)
      }
    );
  } catch (error) {
    console.error(
      '[PIX_PROVIDER_NETWORK_ERROR]',
      {
        path,
        message:
          error instanceof Error
            ? error.message
            : 'unknown'
      }
    );

    throw new PixPaymentError(
      'PIX_PROVIDER_UNAVAILABLE',
      502,
      'Serviço PIX temporariamente indisponível.'
    );
  }

  const body: any =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    console.error(
      '[PIX_PROVIDER_HTTP_ERROR]',
      {
        path,
        status: response.status,
        message:
          body?.message ?? null
      }
    );

    throw new PixPaymentError(
      'PIX_PROVIDER_ERROR',
      502,
      'Não foi possível processar o PIX.'
    );
  }

  return body;
};

export const checkMisticPayTransaction =
  async (
    credentials: unknown,
    providerTransactionId: string
  ) => {
    return providerRequest(
      '/transactions/check',
      credentials,
      {
        transactionId:
          providerTransactionId
      }
    );
  };

export interface ExecutePixPaymentInput {
  amount: number;
  currency: string;
  storeId: string;
  merchantReference: string;

  customer?: {
    name?: string;
    fullName?: string;
    email?: string;
    document?: string;
    cpf?: string;
    taxId?: string;
    tax_id?: string;
    [key: string]: unknown;
  };

  metadata?: Record<string, any>;
}

export const executePixPayment =
  async (
    input: ExecutePixPaymentInput
  ) => {
    const amountInCents =
      Number(input.amount);

    if (
      !Number.isInteger(
        amountInCents
      ) ||
      amountInCents <= 0
    ) {
      throw new PixPaymentError(
        'INVALID_AMOUNT',
        400,
        'O amount deve ser um inteiro positivo em centavos.'
      );
    }

    const currency =
      String(input.currency || '')
        .trim()
        .toUpperCase();

    if (currency !== 'BRL') {
      throw new PixPaymentError(
        'PIX_BRL_REQUIRED',
        400,
        'PIX aceita apenas pagamentos em BRL.'
      );
    }

    const store =
      await prisma.store.findUnique({
        where: {
          id: input.storeId
        }
      });

    if (
      !store ||
      store.status !== 'active'
    ) {
      throw new PixPaymentError(
        'STORE_INACTIVE',
        401,
        'Acesso negado.'
      );
    }

    if (
      String(store.currency)
        .toUpperCase() !== 'BRL'
    ) {
      throw new PixPaymentError(
        'STORE_CURRENCY_MISMATCH',
        409,
        'Store não configurada para BRL.'
      );
    }

    const routingRules =
      parseRoutingRules(
        store.routingRules
      );

    const targetProvider =
      String(
        routingRules.pix || ''
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

    const vaults =
      await prisma.gatewayVault.findMany({
        where: {
          merchantId:
            store.merchantId,
          isActive: true,
          OR: [
            {
              storeId: null
            },
            {
              storeId: store.id
            }
          ]
        }
      });

    const gatewayVault =
      vaults.find(
        vault =>
          vault.provider
            .toLowerCase() ===
          targetProvider
      );

    if (
      !gatewayVault ||
      !gatewayVault.provider
        .toLowerCase()
        .startsWith('misticpay')
    ) {
      throw new PixPaymentError(
        'PIX_GATEWAY_NOT_CONFIGURED',
        500,
        'Gateway PIX não configurado.'
      );
    }

    // Garante que CI/CS existem antes
    // de persistir qualquer cobrança.
    getCredentials(
      gatewayVault.credentials
    );

    const customer =
      input.customer || {};

    const metadata =
      input.metadata || {};

    const payerName =
      String(
        customer.name ??
        customer.fullName ??
        metadata.payerName ??
        ''
      ).trim();

    const payerDocument =
      String(
        customer.document ??
        customer.cpf ??
        customer.taxId ??
        customer.tax_id ??
        metadata.payerDocument ??
        metadata.cpf ??
        ''
      )
        .replace(/\D/g, '');

    if (!payerName) {
      throw new PixPaymentError(
        'PIX_PAYER_NAME_REQUIRED',
        400,
        'Nome do pagador é obrigatório para PIX.'
      );
    }

    if (
      !/^\d{11}$/.test(
        payerDocument
      ) &&
      !/^\d{14}$/.test(
        payerDocument
      )
    ) {
      throw new PixPaymentError(
        'PIX_PAYER_DOCUMENT_REQUIRED',
        400,
        'Informe CPF ou CNPJ válido para PIX.'
      );
    }

    const reference =
      String(
        input.merchantReference ||
        `PIX-${Date.now()}`
      ).trim();

    let transaction =
      await prisma.transaction.findFirst({
        where: {
          merchantId:
            store.merchantId,
          reference
        }
      });

    if (
      transaction?.status ===
      'succeeded'
    ) {
      throw new PixPaymentError(
        'TRANSACTION_ALREADY_PAID',
        409,
        'Transação já paga.'
      );
    }

    /*
     * Idempotência XPAYMENTS:
     * se já criámos o PIX anteriormente
     * e ainda temos o QR armazenado,
     * devolvemos o mesmo PIX.
     */
    if (
      transaction?.providerId &&
      transaction.status ===
        'pending'
    ) {
      const previous =
        asRecord(
          transaction.rawResponse
        );

      const previousPix =
        asRecord(previous.pix);

      if (
        previousPix.copyPaste
      ) {
        return {
          transactionId:
            transaction.id,
          reference,
          status: 'pending',
          method: 'pix',
          action: {
            type: 'pix',
            copyPaste:
              previousPix.copyPaste,
            pixString:
              previousPix.copyPaste,
            qrCode:
              previousPix.qrCodeBase64 ??
              previousPix.qrCodeUrl ??
              null,
            qrCodeBase64:
              previousPix.qrCodeBase64 ??
              null,
            qrCodeUrl:
              previousPix.qrCodeUrl ??
              null
          }
        };
      }
    }

    const safeRawRequest = {
      amount: amountInCents,
      currency: 'BRL',
      payment_method_types: [
        'pix'
      ],
      reference,
      customer: {
        name: payerName,
        email:
          customer.email ??
          null,
        documentLast4:
          payerDocument.slice(-4)
      }
    };

    if (transaction) {
      transaction =
        await prisma.transaction.update({
          where: {
            id: transaction.id
          },
          data: {
            storeId:
              store.id,
            gatewayVaultId:
              gatewayVault.id,
            amount:
              amountInCents / 100,
            currency: 'BRL',
            status: 'pending',
            method: 'pix',

            /*
             * Public-facing gateway name.
             * Provider real permanece
             * identificado pelo Vault.
             */
            gateway: 'pix',

            providerId: null,
            customer:
              payerName,
            customerEmail:
              customer.email
                ? String(
                    customer.email
                  )
                : null,
            rawRequest:
              safeRawRequest
          }
        });
    } else {
      transaction =
        await prisma.transaction.create({
          data: {
            merchantId:
              store.merchantId,
            storeId:
              store.id,
            gatewayVaultId:
              gatewayVault.id,
            reference,
            amount:
              amountInCents / 100,
            currency: 'BRL',
            status: 'pending',
            method: 'pix',
            gateway: 'pix',
            customer:
              payerName,
            customerEmail:
              customer.email
                ? String(
                    customer.email
                  )
                : null,
            rawRequest:
              safeRawRequest
          }
        });
    }

    const providerPayload = {
      amount:
        Number(
          (
            amountInCents /
            100
          ).toFixed(2)
        ),

      payerName,

      payerDocument,

      transactionId:
        transaction.id,

      description:
        String(
          metadata.description ??
          `Pagamento ${reference}`
        ).slice(0, 180),

      projectWebhook:
        MISTICPAY_WEBHOOK_URL
    };

    let providerResponse: any;

    try {
      providerResponse =
        await providerRequest(
          '/transactions/create',
          gatewayVault.credentials,
          providerPayload
        );
    } catch (error) {
      await prisma.transaction
        .update({
          where: {
            id: transaction.id
          },
          data: {
            status: 'failed'
          }
        })
        .catch(() => undefined);

      throw error;
    }

    const providerData =
      asRecord(
        providerResponse?.data
      );

    const providerTransactionId =
      String(
        providerData
          .transactionId ?? ''
      ).trim();

    const copyPaste =
      String(
        providerData
          .copyPaste ?? ''
      ).trim();

    if (
      !providerTransactionId ||
      !copyPaste
    ) {
      await prisma.transaction.update({
        where: {
          id: transaction.id
        },
        data: {
          status: 'failed',
          rawResponse: {
            status:
              'invalid_provider_response'
          }
        }
      });

      throw new PixPaymentError(
        'PIX_INVALID_PROVIDER_RESPONSE',
        502,
        'Resposta PIX inválida.'
      );
    }

    const safeProviderResponse = {
      transactionState:
        providerData
          .transactionState ??
        'PENDENTE',

      transactionType:
        providerData
          .transactionType ??
        'DEPOSITO',

      transactionMethod:
        providerData
          .transactionMethod ??
        'PIX',

      transactionAmount:
        providerData
          .transactionAmount ??
        null,

      transactionFee:
        providerData
          .transactionFee ??
        null,

      pix: {
        copyPaste,

        qrCodeBase64:
          providerData
            .qrCodeBase64 ??
          null,

        qrCodeUrl:
          providerData
            .qrcodeUrl ??
          null
      }
    };

    await prisma.transaction.update({
      where: {
        id: transaction.id
      },
      data: {
        providerId:
          providerTransactionId,
        status: 'pending',
        rawResponse:
          safeProviderResponse
      }
    });

    console.log(
      '[PIX CREATED]',
      {
        transactionId:
          transaction.id,
        reference,
        amount:
          amountInCents / 100,
        currency: 'BRL',
        storeId:
          store.id
      }
    );

    /*
     * IMPORTANTE:
     * nada de providerId/provider name
     * sai na API pública.
     */
    return {
      transactionId:
        transaction.id,
      reference,
      status: 'pending',
      method: 'pix',
      action: {
        type: 'pix',

        copyPaste,

        pixString:
          copyPaste,

        qrCode:
          providerData
            .qrCodeBase64 ??
          providerData
            .qrcodeUrl ??
          null,

        qrCodeBase64:
          providerData
            .qrCodeBase64 ??
          null,

        qrCodeUrl:
          providerData
            .qrcodeUrl ??
          null
      }
    };
  };
