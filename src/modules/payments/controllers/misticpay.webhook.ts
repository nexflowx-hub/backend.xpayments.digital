import {
  Request,
  Response
} from 'express';

import {
  PrismaClient
} from '@prisma/client';

import {
  checkMisticPayTransaction
} from '../services/misticpay.service';

import {
  dispatchMerchantWebhook
} from '../../../core/utils/webhook-dispatcher';

const prisma =
  new PrismaClient();

const asRecord = (
  value: unknown
): Record<string, any> => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<
      string,
      any
    >;
  }

  return {};
};

const mapStatus = (
  value: string
) => {
  switch (
    value.toUpperCase()
  ) {
    case 'COMPLETO':
      return 'succeeded';

    case 'FALHA':
      return 'failed';

    case 'CANCELADO':
      return 'canceled';

    default:
      return 'pending';
  }
};

const normalizeAmount = (
  rawValue: unknown,
  expected: number
) => {
  const value =
    Number(rawValue);

  if (!Number.isFinite(value)) {
    return NaN;
  }

  if (
    Math.abs(
      value - expected
    ) <= 0.01
  ) {
    return value;
  }

  if (
    Math.abs(
      value / 100 -
      expected
    ) <= 0.01
  ) {
    return value / 100;
  }

  return value;
};

export const handleMisticPayWebhook =
  async (
    req: Request,
    res: Response
  ) => {
    try {
      const payload =
        asRecord(req.body);

      const providerTxId =
        String(
          payload
            .transactionId ??
          ''
        ).trim();

      if (!providerTxId) {
        return res
          .status(200)
          .json({
            received: true,
            ignored: true,
            reason:
              'transaction_id_missing'
          });
      }

      const transaction =
        await prisma.transaction
          .findFirst({
            where: {
              providerId:
                providerTxId,
              method: 'pix'
            },
            include: {
              gatewayVault:
                true
            }
          });

      if (!transaction) {
        console.warn(
          '[PIX WEBHOOK] Transaction not found',
          {
            providerTxId
          }
        );

        return res
          .status(200)
          .json({
            received: true,
            ignored: true,
            reason:
              'transaction_not_found'
          });
      }

      if (
        transaction.status ===
        'succeeded'
      ) {
        return res
          .status(200)
          .json({
            received: true,
            duplicate: true,
            transactionId:
              transaction.id,
            status:
              'succeeded'
          });
      }

      const gatewayVault =
        transaction
          .gatewayVault;

      if (
        !gatewayVault ||
        !gatewayVault.provider
          .toLowerCase()
          .startsWith(
            'misticpay'
          )
      ) {
        console.error(
          '[PIX WEBHOOK] Vault mismatch',
          {
            transactionId:
              transaction.id
          }
        );

        return res
          .status(200)
          .json({
            received: true,
            ignored: true,
            reason:
              'gateway_mismatch'
          });
      }

      /*
       * Não confiamos financeiramente
       * no webhook recebido.
       *
       * Revalidamos a transação
       * diretamente no provider com
       * CI/CS server-to-server.
       */
      const verification =
        await checkMisticPayTransaction(
          gatewayVault.credentials,
          providerTxId
        );

      const checked =
        asRecord(
          verification
            ?.transaction ??
          verification
            ?.data?.transaction ??
          verification
            ?.data
        );

      const providerState =
        String(
          checked
            .transactionState ??
          checked.status ??
          ''
        )
          .trim()
          .toUpperCase();

      const providerType =
        String(
          checked
            .transactionType ??
          ''
        )
          .trim()
          .toUpperCase();

      const providerMethod =
        String(
          checked
            .transactionMethod ??
          ''
        )
          .trim()
          .toUpperCase();

      const newStatus =
        mapStatus(
          providerState
        );

      if (
        providerState !==
        'COMPLETO'
      ) {
        await prisma.transaction
          .updateMany({
            where: {
              id:
                transaction.id,
              status: {
                not:
                  'succeeded'
              }
            },
            data: {
              status:
                newStatus
            }
          });

        const merchantEvent =
          newStatus === 'failed'
            ? 'payment_intent.payment_failed'
            : newStatus === 'canceled'
              ? 'payment_intent.canceled'
              : null;

        if (merchantEvent) {
          try {
            await dispatchMerchantWebhook(
              transaction.id,
              merchantEvent,
              {
                method: 'pix',
                status: newStatus
              }
            );
          } catch (error) {
            console.error(
              '[PIX MERCHANT WEBHOOK ERROR]',
              error
            );
          }
        }

        return res
          .status(200)
          .json({
            received: true,
            transactionId:
              transaction.id,
            status:
              newStatus,
            financialProcessingDone:
              false
          });
      }

      if (
        providerType !==
          'DEPOSITO' ||
        providerMethod !==
          'PIX'
      ) {
        console.error(
          '[PIX WEBHOOK VERIFICATION FAILED]',
          {
            transactionId:
              transaction.id,
            providerType,
            providerMethod
          }
        );

        return res
          .status(200)
          .json({
            received: true,
            processed: false,
            reason:
              'invalid_transaction_type'
          });
      }

      const expectedAmount =
        Number(
          transaction.amount
        );

      const checkedAmount =
        normalizeAmount(
          checked.value ??
          checked
            .transactionAmount,
          expectedAmount
        );

      if (
        !Number.isFinite(
          checkedAmount
        ) ||
        Math.abs(
          checkedAmount -
          expectedAmount
        ) > 0.01
      ) {
        console.error(
          '[PIX AMOUNT MISMATCH]',
          {
            transactionId:
              transaction.id,
            expectedAmount,
            checkedAmount
          }
        );

        return res
          .status(200)
          .json({
            received: true,
            processed: false,
            reason:
              'amount_mismatch'
          });
      }

      let providerFee =
        Number(
          checked.fee ??
          checked
            .transactionFee ??
          0
        );

      if (
        !Number.isFinite(
          providerFee
        ) ||
        providerFee < 0
      ) {
        providerFee = 0;
      }

      /*
       * Algumas respostas do provider
       * utilizam centavos para fee.
       */
      if (
        providerFee >
          expectedAmount &&
        providerFee / 100 <
          expectedAmount
      ) {
        providerFee =
          providerFee / 100;
      }

      providerFee =
        Number(
          providerFee
            .toFixed(2)
        );

      const netAmount =
        Number(
          (
            expectedAmount -
            providerFee
          ).toFixed(2)
        );

      if (
        netAmount < 0
      ) {
        return res
          .status(200)
          .json({
            received: true,
            processed: false,
            reason:
              'invalid_fee'
          });
      }

      const previousResponse =
        asRecord(
          transaction
            .rawResponse
        );

      const financialProcessingDone =
        await prisma.$transaction(
          async tx => {
            /*
             * Claim atómico:
             * apenas uma execução poderá
             * transitar para succeeded.
             */
            const claim =
              await tx.transaction
                .updateMany({
                  where: {
                    id:
                      transaction.id,
                    status: {
                      not:
                        'succeeded'
                    }
                  },
                  data: {
                    status:
                      'succeeded',

                    fee:
                      providerFee,

                    rawResponse: {
                      ...previousResponse,

                      settlement: {
                        status:
                          'COMPLETO',

                        method:
                          'PIX',

                        type:
                          'DEPOSITO',

                        e2e:
                          checked.e2e ??
                          payload.e2e ??
                          null,

                        grossAmount:
                          expectedAmount,

                        providerFee,

                        merchantNet:
                          netAmount,

                        verifiedAt:
                          new Date()
                            .toISOString()
                      }
                    }
                  }
                });

            if (
              claim.count === 0
            ) {
              return false;
            }

            const wallet =
              await tx.wallet
                .upsert({
                  where: {
                    merchantId_currency: {
                      merchantId:
                        transaction
                          .merchantId,

                      currency:
                        'BRL'
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
                      'BRL',

                    balance:
                      netAmount,

                    available: 0,

                    reserved: 0,

                    type: 'fiat'
                  }
                });

            await tx.walletMovement
              .create({
                data: {
                  walletId:
                    wallet.id,

                  merchantId:
                    transaction
                      .merchantId,

                  currency:
                    'BRL',

                  type:
                    'payment',

                  direction:
                    'in',

                  amount:
                    netAmount,

                  status:
                    'pendente',

                  reference:
                    transaction.id,

                  metadata: {
                    method:
                      'pix',

                    grossAmount:
                      expectedAmount,

                    providerFee,

                    merchantNet:
                      netAmount,

                    e2e:
                      checked.e2e ??
                      payload.e2e ??
                      null
                  }
                }
              });

            return true;
          }
        );

      if (
        financialProcessingDone
      ) {
        try {
          await dispatchMerchantWebhook(
            transaction.id,
            'payment_intent.succeeded',
            {
              method:
                'pix',
              status:
                'succeeded'
            }
          );
        } catch (error) {
          console.error(
            '[PIX MERCHANT WEBHOOK ERROR]',
            error
          );
        }
      }

      console.log(
        '[PIX WEBHOOK PROCESSED]',
        {
          transactionId:
            transaction.id,
          status:
            'succeeded',
          amount:
            expectedAmount,
          providerFee,
          netAmount,
          financialProcessingDone
        }
      );

      return res
        .status(200)
        .json({
          received: true,
          transactionId:
            transaction.id,
          status:
            'succeeded',
          financialProcessingDone
        });

    } catch (error) {
      console.error(
        '[PIX WEBHOOK ERROR]',
        error
      );

      /*
       * Neste caso queremos retry do
       * provider porque não conseguimos
       * completar a validação S2S.
       */
      return res
        .status(500)
        .json({
          received: false,
          error:
            'verification_failed'
        });
    }
  };
