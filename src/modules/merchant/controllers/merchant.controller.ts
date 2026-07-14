import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const getProfile = async (req: AuthRequest, res: Response) => {
    try {

        const merchantId = req.user?.id;

        if (!merchantId) {
            return res.status(401).json({
                success: false,
                error: {
                    message: 'Merchant não autenticado.'
                }
            });
        }

        const merchant = await prisma.merchant.findUnique({
            where: {
                id: merchantId
            },
            include: {
                stores: true,
                wallets: true
            }
        });

        if (!merchant) {
            return res.status(404).json({
                success: false,
                error: {
                    message: 'Merchant não encontrado.'
                }
            });
        }

        return res.json({
            success: true,
            data: merchant
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: {
                message: 'Erro interno.'
            }
        });

    }
};

export const getStores = async (req: AuthRequest, res: Response) => {
    try {

        const merchantId = req.user?.id;

        if (!merchantId) {
            return res.status(401).json({
                success: false
            });
        }

        const stores = await prisma.store.findMany({

            where: {
                merchantId
            },

            orderBy: {
                createdAt: 'asc'
            }

        });

        return res.json({
            success: true,
            data: stores
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false
        });

    }
};

export const getStore = async (req: AuthRequest, res: Response) => {
    try {

        const merchantId = req.user?.id;

        if (!merchantId) {
            return res.status(401).json({
                success: false
            });
        }

        const storeId = Array.isArray((req.params as any).id)
            ? (req.params as any).id[0]
            : (req.params as any).id;

        const store = await prisma.store.findFirst({

            where: {

                id: storeId,

                merchantId

            },

            include: {

                apiKeys: true,

                webhooks: true,

                gatewayVaults: true

            }

        });

        if (!store) {

            return res.status(404).json({

                success: false,

                error: {

                    message: 'Loja não encontrada.'

                }

            });

        }

        return res.json({

            success: true,

            data: store

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            error: {

                message: 'Erro interno.'

            }

        });

    }
};
