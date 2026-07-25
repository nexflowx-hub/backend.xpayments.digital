import {
  Request,
  Response
} from 'express';

import {
  PrismaClient
} from '@prisma/client';

import Stripe from 'stripe';

const prisma = new PrismaClient();

const normalizePaymentMethod = (
  value: unknown
): string => {
  const method = String(
    value ?? 'card'
  )
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  if (method === 'mbway') {
    return 'mb_way';
  }

  return method;
};

const normalizePhone = (
  value: unknown,
  paymentMethod: string
): string | null => {
  if (!value) {
    return null;
  }

  let phone = String(value)
    .trim()
    .replace(/\s+/g, '')
    .replace(/[().-]/g, '');

  if (phone.startsWith('00')) {
    phone = `+${phone.slice(2)}`;
  }

  /*
   * Bizum
   *
   * Aceita:
   * 600000001
   * 34600000001
   * 0034600000001
   * +34600000001
   */
  if (paymentMethod === 'bizum') {
    if (/^\d{9}$/.test(phone)) {
      phone = `+34${phone}`;
    } else if (/^34\d{9}$/.test(phone)) {
      phone = `+${phone}`;
    }

    return /^\+34\d{9}$/.test(phone)
      ? phone
      : null;
  }

  /*
   * MB WAY
   *
   * Aceita:
   * 911111111
   * 351911111111
   * 00351911111111
   * +351911111111
   */
  if (paymentMethod === 'mb_way') {
    if (/^\d{9}$/.test(phone)) {
      phone = `+351${phone}`;
    } else if (/^351\d{9}$/.test(phone)) {
      phone = `+${phone}`;
    }

    return /^\+351\d{9}$/.test(phone)
      ? phone
      : null;
  }

  if (!phone.startsWith('+')) {
    phone = `+${phone}`;
  }

  return /^\+\d{8,15}$/.test(phone)
    ? phone
    : null;
};

const parseRoutingRules = (
  rules: unknown
): Record<string, string> => {
  try {
    if (typeof rules === 'string') {
      return JSON.parse(
        rules
          .replace(/\\"/g, '"')
          .replace(/^"|"$/g, '')
      );
    }

    if (
      rules &&
      typeof rules === 'object'
    ) {
      return rules as Record<
        string,
        string
      >;
    }

    return {};
  } catch {
    return {};
  }
};

const sanitizePaymentIntent = (
  paymentIntent: any
) => ({
  id: paymentIntent?.id ?? null,
  object:
    paymentIntent?.object ??
    'payment_intent',
  amount:
    paymentIntent?.amount ?? null,
  amountReceived:
    paymentIntent?.amount_received ??
    null,
  currency:
    paymentIntent?.currency ?? null,
  status:
    paymentIntent?.status ?? null,
  livemode:
    paymentIntent?.livemode ?? null,
  paymentMethodTypes:
    paymentIntent
      ?.payment_method_types ?? [],
  nextActionType:
    paymentIntent?.next_action?.type ??
    null,
  latestCharge:
    paymentIntent?.latest_charge ??
    null,
  failureCode:
    paymentIntent
      ?.last_payment_error?.code ??
    null,
  declineCode:
    paymentIntent
      ?.last_payment_error
      ?.decline_code ?? null,
  failureMessage:
    paymentIntent
      ?.last_payment_error?.message ??
    null
});

const getStripeMode = (
  secretKey: string
): 'test' | 'live' | 'unknown' => {
  if (
    secretKey.startsWith('sk_test_') ||
    secretKey.startsWith('rk_test_')
  ) {
    return 'test';
  }

  if (
    secretKey.startsWith('sk_live_') ||
    secretKey.startsWith('rk_live_')
  ) {
    return 'live';
  }

  return 'unknown';
};

export const processDirectCharge =
  async (
    req: Request,
    res: Response
  ) => {
    let transaction: any = null;

    try {
      const {
        amount,
        currency,
        payment_method_types,
        metadata = {},
        customer = {}
      } = req.body;

      const authorization =
        req.headers.authorization;

      const apiKey =
        authorization?.startsWith(
          'Bearer '
        )
          ? authorization
              .slice('Bearer '.length)
              .trim()
          : String(
              req.headers['x-api-key'] ??
                ''
            ).trim();

      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'API_KEY_REQUIRED',
            message:
              'API Key não fornecida.'
          }
        });
      }

      const keyRecord =
        await prisma.apiKey.findUnique({
          where: {
            key: apiKey
          },
          include: {
            store: true
          }
        });

      if (
        !keyRecord ||
        keyRecord.store.status !==
          'active'
      ) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'ACCESS_DENIED',
            message: 'Acesso negado.'
          }
        });
      }

      const amountInCents =
        Number(amount);

      if (
        !Number.isInteger(
          amountInCents
        ) ||
        amountInCents <= 0
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_AMOUNT',
            message:
              'O amount deve ser um inteiro positivo em cêntimos.'
          }
        });
      }

      const currencyUpper = String(
        currency ?? ''
      )
        .trim()
        .toUpperCase();

      if (
        !/^[A-Z]{3}$/.test(
          currencyUpper
        )
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CURRENCY',
            message: 'Moeda inválida.'
          }
        });
      }

      const rawMethod =
        normalizePaymentMethod(
          payment_method_types?.[0]
        );

      if (
        rawMethod === 'bizum' &&
        currencyUpper !== 'EUR'
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code:
              'BIZUM_EUR_REQUIRED',
            message:
              'Bizum aceita apenas pagamentos em EUR.'
          }
        });
      }

      if (
        rawMethod === 'bizum' &&
        (
          amountInCents < 50 ||
          amountInCents > 500000
        )
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code:
              'BIZUM_AMOUNT_OUT_OF_RANGE',
            message:
              'O valor Bizum deve estar entre EUR 0,50 e EUR 5.000,00.'
          }
        });
      }

      const phone = normalizePhone(
        customer.phone,
        rawMethod
      );

      if (
        rawMethod === 'mb_way' &&
        !phone
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code:
              'INVALID_MBWAY_PHONE',
            message:
              'Telefone inválido para MB WAY.'
          }
        });
      }

      if (
        rawMethod === 'bizum' &&
        !phone
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code:
              'INVALID_BIZUM_PHONE',
            message:
              'Informe um número espanhol válido para Bizum.'
          }
        });
      }

      const store = keyRecord.store;

      const merchantReference =
        String(
          metadata.order_id ??
          metadata.reference ??
          req.body.reference ??
          `REQ-${Date.now()}`
        ).trim();

      transaction =
        await prisma.transaction.findFirst({
          where: {
            merchantId:
              store.merchantId,
            reference:
              merchantReference
          }
        });

      if (
        transaction?.status ===
        'succeeded'
      ) {
        return res.status(409).json({
          success: false,
          error: {
            code:
              'TRANSACTION_ALREADY_PAID',
            message:
              'Transação já paga.'
          }
        });
      }

      const availableVaults =
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

      const routingRules =
        parseRoutingRules(
          store.routingRules
        );

      const targetProvider =
        routingRules[rawMethod];

      let gatewayVault =
        targetProvider
          ? availableVaults.find(
              vault =>
                vault.provider
                  .toLowerCase() ===
                targetProvider
                  .toLowerCase()
            )
          : undefined;

      /*
       * Métodos locais Stripe:
       * na ausência de routing rule,
       * priorizar um Stripe Vault.
       */
      if (
        !gatewayVault &&
        [
          'bizum',
          'mb_way',
          'multibanco'
        ].includes(rawMethod)
      ) {
        gatewayVault =
          availableVaults.find(
            vault =>
              vault.provider
                .toLowerCase()
                .startsWith('stripe')
          );
      }

      gatewayVault ??=
        availableVaults[0];

      if (!gatewayVault) {
        return res.status(400).json({
          success: false,
          error: {
            code:
              'GATEWAY_NOT_CONFIGURED',
            message:
              `Nenhum provedor para ${rawMethod}.`
          }
        });
      }

      if (
        !gatewayVault.provider
          .toLowerCase()
          .startsWith('stripe')
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code:
              'PROVIDER_NOT_SUPPORTED',
            message:
              'Provedor não suportado para este método.'
          }
        });
      }

      const credentials =
        gatewayVault.credentials as any;

      const stripeSecretKey =
        String(
          credentials?.secretKey ?? ''
        ).trim();

      if (!stripeSecretKey) {
        return res.status(500).json({
          success: false,
          error: {
            code:
              'STRIPE_NOT_CONFIGURED',
            message:
              'Credenciais Stripe não configuradas.'
          }
        });
      }

      const stripeMode =
        getStripeMode(
          stripeSecretKey
        );

      const apiKeyEnvironment =
        String(
          keyRecord.environment ??
            'test'
        )
          .trim()
          .toLowerCase();

      if (
        apiKeyEnvironment === 'test' &&
        stripeMode !== 'test'
      ) {
        return res.status(409).json({
          success: false,
          error: {
            code:
              'TEST_KEY_LIVE_GATEWAY_MISMATCH',
            message:
              'A API Key de teste não pode utilizar um Gateway Stripe Live.'
          }
        });
      }

      if (
        apiKeyEnvironment === 'live' &&
        stripeMode !== 'live'
      ) {
        return res.status(409).json({
          success: false,
          error: {
            code:
              'LIVE_KEY_TEST_GATEWAY_MISMATCH',
            message:
              'A API Key Live não pode utilizar um Gateway Stripe Test.'
          }
        });
      }

      if (transaction) {
        transaction =
          await prisma.transaction.update({
            where: {
              id: transaction.id
            },
            data: {
              amount:
                amountInCents / 100,
              currency:
                currencyUpper,
              status: 'pending',
              method: rawMethod,
              gateway:
                gatewayVault.provider,
              gatewayVaultId:
                gatewayVault.id,
              providerId: null,
              customerEmail:
                customer.email || null,
              rawRequest:
                JSON.parse(
                  JSON.stringify(
                    req.body
                  )
                )
            }
          });
      } else {
        transaction =
          await prisma.transaction.create({
            data: {
              merchantId:
                store.merchantId,
              storeId: store.id,
              gatewayVaultId:
                gatewayVault.id,
              reference:
                merchantReference,
              amount:
                amountInCents / 100,
              currency:
                currencyUpper,
              status: 'pending',
              method: rawMethod,
              gateway:
                gatewayVault.provider,
              rawRequest:
                JSON.parse(
                  JSON.stringify(
                    req.body
                  )
                ),
              customerEmail:
                customer.email || null
            }
          });
      }

      const stripeClient =
        new Stripe(
          stripeSecretKey,
          {
            apiVersion:
              '2026-06-24.dahlia' as any
          }
        );

      const stripePayload: any = {
        amount: amountInCents,
        currency:
          currencyUpper.toLowerCase(),
        payment_method_types: [
          rawMethod
        ],
        metadata: {
          nexflowx_transaction_id:
            transaction.id,
          merchant_reference:
            merchantReference
        }
      };

      const billing = {
        phone: phone || undefined,
        email:
          customer.email || undefined,
        name:
          customer.name || undefined
      };

      if (rawMethod === 'mb_way') {
        stripePayload.payment_method_data =
          {
            type: 'mb_way',
            billing_details: billing
          };

        stripePayload.confirm = true;
      }

      if (
        rawMethod === 'multibanco'
      ) {
        stripePayload.payment_method_data =
          {
            type: 'multibanco',
            billing_details: billing
          };

        stripePayload.confirm = true;
      }

      if (rawMethod === 'bizum') {
        stripePayload.payment_method_data =
          {
            type: 'bizum',
            billing_details: billing
          };

        stripePayload.confirm = true;

        stripePayload.return_url =
          String(
            metadata.return_url ??
              'https://xpayments.digital/callback'
          );
      }

      const idempotencyKey =
        [
          'xpayments',
          store.id,
          merchantReference,
          rawMethod
        ]
          .join(':')
          .slice(0, 255);

      const paymentIntent =
        await stripeClient
          .paymentIntents
          .create(
            stripePayload,
            {
              idempotencyKey
            }
          );

      const providerStatus =
        paymentIntent.status;

      const immediateDbStatus =
        providerStatus ===
          'requires_payment_method'
          ? 'failed'
          : providerStatus ===
              'canceled'
            ? 'canceled'
            : 'pending';

      await prisma.transaction.update({
        where: {
          id: transaction.id
        },
        data: {
          providerId:
            paymentIntent.id,
          status:
            immediateDbStatus,
          rawResponse:
            sanitizePaymentIntent(
              paymentIntent
            )
        }
      });

      let orchestratorAction:
        | Record<string, unknown>
        | null = null;

      if (
        providerStatus ===
        'requires_action'
      ) {
        const nextAction =
          paymentIntent.next_action as any;

        if (
          rawMethod ===
            'multibanco' &&
          nextAction
            ?.multibanco_display_details
        ) {
          orchestratorAction = {
            type:
              'multibanco_reference',
            entidade:
              nextAction
                .multibanco_display_details
                .entity,
            referencia:
              nextAction
                .multibanco_display_details
                .reference,
            montante:
              `${(
                amountInCents / 100
              ).toFixed(2)} ${currencyUpper}`
          };
        } else if (
          rawMethod === 'mb_way'
        ) {
          orchestratorAction = {
            type: 'bank_app',
            message:
              'Pedido MB WAY enviado. Confirme na aplicação.'
          };
        } else if (
          rawMethod === 'bizum'
        ) {
          orchestratorAction = {
            type: 'bank_app',
            message:
              'Pedido Bizum enviado. Confirme na aplicação do seu banco.'
          };

          const redirectUrl =
            nextAction
              ?.redirect_to_url
              ?.url;

          if (redirectUrl) {
            orchestratorAction.url =
              redirectUrl;
          }
        } else if (
          nextAction
            ?.redirect_to_url?.url
        ) {
          orchestratorAction = {
            type: 'redirect',
            url:
              nextAction
                .redirect_to_url.url
          };
        }
      }

      return res.status(200).json({
        success: true,
        transactionId:
          transaction.id,
        reference:
          merchantReference,
        providerId:
          paymentIntent.id,
        status:
          providerStatus,
        method: rawMethod,
        action:
          orchestratorAction
      });
    } catch (error: any) {
      const paymentIntent =
        error?.payment_intent ??
        error?.raw?.payment_intent ??
        null;

      if (
        transaction &&
        paymentIntent
      ) {
        try {
          await prisma.transaction.update({
            where: {
              id: transaction.id
            },
            data: {
              status: 'failed',
              providerId:
                paymentIntent.id ??
                null,
              rawResponse:
                sanitizePaymentIntent(
                  paymentIntent
                )
            }
          });
        } catch (
          persistenceError
        ) {
          console.error(
            '[DIRECT_CHARGE_FAILURE_PERSIST_ERROR]',
            persistenceError
          );
        }

        return res.status(402).json({
          success: false,
          transactionId:
            transaction.id,
          reference:
            transaction.reference,
          providerId:
            paymentIntent.id ??
            null,
          status: 'failed',
          providerStatus:
            paymentIntent.status ??
            'requires_payment_method',
          method:
            transaction.method,
          error: {
            code:
              error?.code ??
              paymentIntent
                ?.last_payment_error
                ?.code ??
              'PAYMENT_FAILED',
            declineCode:
              error?.decline_code ??
              paymentIntent
                ?.last_payment_error
                ?.decline_code ??
              null,
            message:
              'O pagamento não foi autorizado.'
          }
        });
      }

      console.error(
        '[DIRECT_CHARGE_ERROR]',
        {
          type:
            error?.type ?? null,
          code:
            error?.code ?? null,
          message:
            error?.message ??
            'Unknown error'
        }
      );

      return res.status(500).json({
        success: false,
        error: {
          code:
            'PAYMENT_PROCESSING_ERROR',
          message:
            'Não foi possível processar o pagamento.'
        }
      });
    }
  };
