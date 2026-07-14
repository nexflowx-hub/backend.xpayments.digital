import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { formatWallet } from '../../../core/utils/api-formatters';

export const getWallets = async (req: AuthRequest, res: Response) => {

    try {

        if (!req.user?.id) {
            return res.status(401).json({
                success: false,
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Merchant não autenticado.'
                }
            });
        }

        const merchantId = req.user.id;

        const wallets = await prisma.wallet.findMany({
            where: {
                merchantId
            },
            orderBy: {
                currency: 'asc'
            }
        });

        const summary = {

            totalBalance:
                wallets.reduce(
                    (sum, w) => sum + Number(w.balance),
                    0
                ),

            totalAvailable:
                wallets.reduce(
                    (sum, w) => sum + Number(w.available),
                    0
                ),

            totalReserved:
                wallets.reduce(
                    (sum, w) => sum + Number(w.reserved),
                    0
                ),

            currencies: wallets.length

        };

        return res.json({

            success: true,

            data: {

                wallets: wallets.map(formatWallet),

                summary

            }

        });

    }
    catch (error) {

        console.error('[WALLETS]', error);

        return res.status(500).json({

            success: false,

            error: {

                code: 'WALLET_ERROR',

                message: 'Erro ao carregar wallets.'

            }

        });

    }

};

export const getWalletMovements = async (req: AuthRequest, res: Response) => {

    try {

        const merchantId = req.user!.id;

        const movements = await prisma.walletMovement.findMany({

            where: {

                merchantId

            },

            include: {

                wallet: {

                    select: {

                        currency: true

                    }

                }

            },

            orderBy: {

                createdAt: 'desc'

            },

            take: 50

        });

        return res.json({

            success: true,

            data: movements

        });

    }
    catch (error) {

        console.error('[MOVEMENTS]', error);

        return res.status(500).json({

            success: false,

            error: {

                code: 'MOVEMENTS_ERROR',

                message: 'Erro ao carregar movimentos.'

            }

        });

    }

};

export const getPayouts = async (req: AuthRequest, res: Response) => {

    return res.json({
        success: true,
        data: []
    });

};

export const getDeposits = async (req: AuthRequest, res: Response) => {

    return res.json({
        success: true,
        data: []
    });

};

export const getTreasuryOverview = async (req: AuthRequest, res: Response) => {

    try {

        const merchantId = req.user!.id;

        const wallets = await prisma.wallet.findMany({

            where: {

                merchantId

            }

        });

        return res.json({

            success: true,

            data: {

                totalBalance:
                    wallets.reduce((s, w) => s + Number(w.balance), 0),

                availableBalance:
                    wallets.reduce((s, w) => s + Number(w.available), 0),

                reservedBalance:
                    wallets.reduce((s, w) => s + Number(w.reserved), 0),

                wallets

            }

        });

    }
    catch (error) {

        return res.status(500).json({

            success: false,

            error: {

                code: 'TREASURY_ERROR',

                message: 'Erro ao carregar tesouraria.'

            }

        });

    }

};
