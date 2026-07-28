import { Response } from 'express';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const getParamId = (
  value: string | string[]
): string =>
  Array.isArray(value)
    ? value[0]
    : String(value);

export const revealApiKey = async (
  req: AuthRequest,
  res: Response
) => {
  const merchantId =
    req.merchantId || req.user?.id;

  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Merchant não autenticado.'
      }
    });
  }

  const apiKeyId = getParamId(
    req.params.id
  );

  try {
    const apiKey =
      await prisma.apiKey.findFirst({
        where: {
          id: apiKeyId,
          store: {
            merchantId: String(merchantId)
          }
        },
        include: {
          store: {
            select: {
              id: true,
              name: true,
              storeCode: true
            }
          }
        }
      });

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'API_KEY_NOT_FOUND',
          message:
            'Chave de API não encontrada.'
        }
      });
    }

    console.log(
      '[API_KEY_REVEALED]',
      {
        merchantId:
          String(merchantId),
        apiKeyId:
          apiKey.id,
        storeId:
          apiKey.store.id,
        storeCode:
          apiKey.store.storeCode,
        revealedAt:
          new Date().toISOString()
      }
    );

    return res.status(200).json({
      success: true,
      data: {
        id: apiKey.id,
        storeId: apiKey.store.id,
        storeName: apiKey.store.name,
        storeCode:
          apiKey.store.storeCode,
        name: apiKey.name,
        environment:
          apiKey.environment,
        scopes: apiKey.scopes,
        fullKey: apiKey.key
      }
    });
  } catch (error) {
    console.error(
      '[API_KEY_REVEAL_ERROR]',
      error
    );

    return res.status(500).json({
      success: false,
      error: {
        code: 'API_KEY_REVEAL_ERROR',
        message:
          'Erro ao visualizar a chave de API.'
      }
    });
  }
};
