import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const getOverview = async (req: AuthRequest, res: Response) => {
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

        const today = new Date();
        today.setHours(0,0,0,0);

        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

        const [
            wallets,
            todayTransactions,
            monthTransactions,
            totalTransactions,
            approvedTransactions,
            recentTransactions
        ] = await Promise.all([

            prisma.wallet.findMany({
                where:{ merchantId },
                orderBy:{ currency:'asc' }
            }),

            prisma.transaction.findMany({
                where:{
                    merchantId,
                    createdAt:{ gte: today },
                    status:'succeeded'
                }
            }),

            prisma.transaction.findMany({
                where:{
                    merchantId,
                    createdAt:{ gte: monthStart },
                    status:'succeeded'
                }
            }),

            prisma.transaction.count({
                where:{ merchantId }
            }),

            prisma.transaction.count({
                where:{
                    merchantId,
                    status:'succeeded'
                }
            }),

            prisma.transaction.findMany({

                where:{ merchantId },

                orderBy:{
                    createdAt:'desc'
                },

                take:10,

                select:{
                    id:true,
                    reference:true,
                    customer:true,
                    amount:true,
                    currency:true,
                    status:true,
                    method:true,
                    gateway:true,
                    createdAt:true
                }

            })

        ]);

        const totalBalance =
            wallets.reduce(
                (sum,w)=>sum + Number(w.balance),
                0
            );

        const availableBalance =
            wallets.reduce(
                (sum,w)=>sum + Number(w.available),
                0
            );

        const volumeToday =
            todayTransactions.reduce(
                (sum,t)=>sum + Number(t.amount),
                0
            );

        const volumeMonth =
            monthTransactions.reduce(
                (sum,t)=>sum + Number(t.amount),
                0
            );

        const successRate =
            totalTransactions === 0
                ? 100
                : Number(((approvedTransactions/totalTransactions)*100).toFixed(2));

        return res.json({

            success:true,

            data:{

                wallet:{
                    totalBalance,
                    availableBalance,
                    currencies:wallets.length
                },

                transactions:{
                    today:todayTransactions.length,
                    month:monthTransactions.length,
                    total:totalTransactions,
                    successRate,
                    volumeToday,
                    volumeMonth
                },

                recentTransactions

            }

        });

    }
    catch(error){

        console.error('[ANALYTICS]',error);

        return res.status(500).json({

            success:false,

            error:{
                code:'ANALYTICS_ERROR',
                message:'Erro ao carregar Dashboard.'
            }

        });

    }
};
