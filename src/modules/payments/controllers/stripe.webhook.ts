import {
  Request,
  Response
} from 'express';

import {
  PrismaClient
} from '@prisma/client';

import {
  dispatchMerchantWebhook
} from '../../../core/utils/webhook-dispatcher';

const prisma = new PrismaClient();

const supportedEvents = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled'
]);

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
  paymentMethod:
    typeof paymentIntent
      ?.payment_method === 'string'
      ? paymentIntent.payment_method
      : paymentIntent
          ?.payment_method?.id ??
        null,
  paymentMethodTypes:
    paymentIntent
      ?.payment_method_types ?? [],
  latestCharge:
    typeof paymentIntent
      ?.latest_charge === 'string'
      ? paymentIntent.latest_charge
      : paymentIntent
          ?.latest_charge?.id ??
        null,
  nextActionType:
    paymentIntent
      ?.next_action?.type ??
    null,
  failureCode:
    paymentIntent
      ?.last_payment_error?.code ??
    null,
  declineCode:
    paymentIntent
      ?.last_payment_error
      ?.decline_code ??
    null,
  failureMessage:
    paymentIntent
      ?.last_payment_error
      ?.message ??
    null,
  metadata: {
    nexflowxTransactionId:
      paymentIntent
        ?.metadata
        ?.nexflowx_transaction_id ??
      null,
    merchantReference:
      paymentIntent
        ?.metadata
        ?.merchant_reference ??
      null
  }
});

const mapEventStatus = (
  eventType: string
): string => {
  switch (eventType) {
    case 'payment_intent.succeeded':
      return 'succeeded';

    case 'payment_intent.payment_failed':
      return 'failed';

    case 'payment_intent.processing':
      return 'processing';

    case 'payment_intent.canceled':
      return 'canceled';

    default:
      return 'pending';
  }
};

export const handleStripeWebhook =
  async (
    req: Request,
    res: Response
  ) => {
    try {
      const event = req.body;

      if (
        !event ||
        !supportedEvents.has(
          String(event.type)
        )
      ) {
        return res.status(200).json({
          received: true,
          ignored: true
        });
      }

      const paymentIntent =
        event.data?.object;

      const transactionId =
        paymentIntent
          ?.metadata
          ?.nexflowx_transaction_id;

      if (!transactionId) {
        console.log(
          '⚠️ [STRIPE WEBHOOK] Ignorado: sem nexflowx_transaction_id.'
        );

        return res.status(200).json({
          received: true,
          ignored: true,
          reason:
            'transaction_id_missing'
        });
      }

      const transaction =
        await prisma.transaction.findUnique({
          where: {
            id: transactionId
          }
        });

      if (!transaction) {
        /*
         * Retornamos 200 para evitar retries
         * infinitos de um objeto que não
         * pertence a esta base.
         */
        console.warn(
          '[STRIPE WEBHOOK] Transação não encontrada:',
          transactionId
        );

        return res.status(200).json({
          received: true,
          ignored: true,
          reason:
            'transaction_not_found'
        });
      }

      const newStatus =
        mapEventStatus(event.type);

      const safeResponse =
        sanitizePaymentIntent(
          paymentIntent
        );

      const amountNum =
        Number(transaction.amount);

      const feeRate = 0.02;

      const totalFee =
        newStatus === 'succeeded'
          ? Number(
              (
                amountNum *
                feeRate
              ).toFixed(2)
            )
          : 0;

      const netAmount =
        newStatus === 'succeeded'
          ? Number(
              (
                amountNum -
                totalFee
              ).toFixed(2)
            )
          : 0;

      let financialProcessingDone =
        false;

      if (
        newStatus === 'succeeded'
      ) {
        financialProcessingDone =
          await prisma.$transaction(
            async tx => {
              /*
               * Claim atómico.
               *
               * Apenas uma execução consegue
               * mudar uma transação ainda não
               * succeeded para succeeded.
               */
              const claim =
                await tx.transaction.updateMany({
                  where: {
                    id: transactionId,
                    status: {
                      not: 'succeeded'
                    }
                  },
                  data: {
                    status: 'succeeded',
                    providerId:
                      paymentIntent.id,
                    fee: totalFee,
                    rawResponse:
                      safeResponse
                  }
                });

              if (
                claim.count === 0
              ) {
                return false;
              }

              const currencyUpper =
                transaction.currency
                  .toUpperCase();

              const wallet =
                await tx.wallet.upsert({
                  where: {
                    merchantId_currency: {
                      merchantId:
                        transaction
                          .merchantId,
                      currency:
                        currencyUpper
                    }
                  },
                  update: {
                    balance: {
                      increment:
                        netAmount
                    }
                  },
                  create: {
                    merchantId:
                      transaction
                        .merchantId,
                    currency:
                      currencyUpper,
                    balance:
                      netAmount,
                    available: 0,
                    reserved: 0,
                    type: 'fiat'
                  }
                });

              await tx.walletMovement.create({
                data: {
                  walletId:
                    wallet.id,
                  merchantId:
                    transaction
                      .merchantId,
                  currency:
                    currencyUpper,
                  type: 'payment',
                  direction: 'in',
                  amount:
                    netAmount,
                  status: 'pendente',
                  reference:
                    transaction.id,
                  metadata: {
                    provider:
                      'stripe',
                    providerId:
                      paymentIntent.id,
                    eventId:
                      event.id ?? null,
                    grossAmount:
                      amountNum,
                    fee:
                      totalFee,
                    netAmount
                  }
                }
              });

              return true;
            }
          );
      } else {
        /*
         * Nunca permitir que um evento
         * tardio de failure/canceled
         * reverta uma transação succeeded.
         */
        await prisma.transaction.updateMany({
          where: {
            id: transactionId,
            status: {
              not: 'succeeded'
            }
          },
          data: {
            status:
              newStatus,
            providerId:
              paymentIntent.id,
            fee: 0,
            rawResponse:
              safeResponse
          }
        });
      }

      /*
       * Envia a notificação externa mesmo
       * quando o evento é repetido.
       *
       * O Merchant deve deduplicar por
       * transaction + event type.
       */
      try {
        await dispatchMerchantWebhook(
          transaction.id,
          event.type,
          safeResponse
        );
      } catch (dispatchError) {
        console.error(
          '[MERCHANT_WEBHOOK_DISPATCH_ERROR]',
          dispatchError
        );

        /*
         * O processamento Stripe já foi
         * concluído. Não devolvemos 500 para
         * evitar duplicação financeira.
         */
      }

      console.log(
        '[STRIPE WEBHOOK PROCESSED]',
        {
          eventId:
            event.id ?? null,
          eventType:
            event.type,
          transactionId,
          providerId:
            paymentIntent.id,
          status:
            newStatus,
          financialProcessingDone
        }
      );

      return res.status(200).json({
        received: true,
        transactionId,
        status:
          newStatus,
        financialProcessingDone
      });
    } catch (error) {
      console.error(
        '[STRIPE WEBHOOK FATAL ERROR]',
        error
      );

      return res.status(500).json({
        received: false,
        error:
          'internal_server_error'
      });
    }
  };
