import {
  Request,
  Response
} from 'express';

import {
  PrismaClient
} from '@prisma/client';

import {
  executePixPayment,
  PixPaymentError
} from '../services/misticpay.service';

const prisma =
  new PrismaClient();

export const processPixCharge =
  async (
    req: Request,
    res: Response
  ) => {
    try {
      const authorization =
        req.headers.authorization;

      const apiKey =
        authorization?.startsWith(
          'Bearer '
        )
          ? authorization
              .slice(
                'Bearer '.length
              )
              .trim()
          : String(
              req.headers[
                'x-api-key'
              ] ?? ''
            ).trim();

      if (!apiKey) {
        return res
          .status(401)
          .json({
            success: false,
            error: {
              code:
                'API_KEY_REQUIRED',
              message:
                'API Key não fornecida.'
            }
          });
      }

      const keyRecord =
        await prisma.apiKey
          .findUnique({
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
        return res
          .status(401)
          .json({
            success: false,
            error: {
              code:
                'ACCESS_DENIED',
              message:
                'Acesso negado.'
            }
          });
      }

      if (
        !keyRecord.scopes.includes(
          'payments_write'
        )
      ) {
        return res
          .status(403)
          .json({
            success: false,
            error: {
              code:
                'INSUFFICIENT_SCOPE',
              message:
                'API Key sem permissão de cobrança.'
            }
          });
      }

      const amount =
        Number(
          req.body?.amount
        );

      const currency =
        String(
          req.body?.currency ??
          ''
        )
          .trim()
          .toUpperCase();

      if (
        !Number.isInteger(
          amount
        ) ||
        amount <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error: {
              code:
                'INVALID_AMOUNT',
              message:
                'O amount deve ser um inteiro positivo em centavos.'
            }
          });
      }

      if (
        currency !== 'BRL'
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error: {
              code:
                'PIX_BRL_REQUIRED',
              message:
                'PIX aceita apenas BRL.'
            }
          });
      }

      const metadata =
        req.body?.metadata &&
        typeof req.body
          .metadata ===
          'object'
          ? req.body.metadata
          : {};

      const reference =
        String(
          metadata.order_id ??
          metadata.reference ??
          req.body.reference ??
          `PIX-${Date.now()}`
        ).trim();

      const result =
        await executePixPayment({
          amount,
          currency,
          storeId:
            keyRecord.store.id,
          merchantReference:
            reference,
          customer:
            req.body?.customer ??
            {},
          metadata
        });

      return res
        .status(200)
        .json({
          success: true,
          ...result
        });

    } catch (error) {
      if (
        error instanceof
        PixPaymentError
      ) {
        return res
          .status(
            error.statusCode
          )
          .json({
            success: false,
            error: {
              code:
                error.code,
              message:
                error.message
            }
          });
      }

      console.error(
        '[PIX_CHARGE_ERROR]',
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error: {
            code:
              'PIX_PROCESSING_ERROR',
            message:
              'Não foi possível processar o PIX.'
          }
        });
    }
  };
