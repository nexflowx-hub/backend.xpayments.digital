import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const listTransactions = async (req: AuthRequest, res: Response) => {
    try {
        const merchantId = req.user?.id || (req as any).merchantId;

        if (!merchantId) {
            return res.status(401).json({
                success: false,
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Merchant não autenticado.'
                }
            });
        }

        const page = Math.max(Number(req.query.page || 1), 1);
        const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
        const skip = (page - 1) * limit;

        const where: any = { merchantId: String(merchantId) };

        if (req.query.status) where.status = String(req.query.status);
        if (req.query.gateway) where.gateway = String(req.query.gateway);
        if (req.query.currency) where.currency = String(req.query.currency);
        if (req.query.method) where.method = String(req.query.method);
        if (req.query.country) where.country = String(req.query.country);

        const searchTerm = req.query.search || req.query.reference;
        if (searchTerm) {
            where.reference = {
                contains: String(searchTerm),
                mode: 'insensitive'
            };
        }

        if (req.query.from || req.query.to) {
            where.createdAt = {};
            if (req.query.from) where.createdAt.gte = new Date(String(req.query.from));
            if (req.query.to) where.createdAt.lte = new Date(String(req.query.to));
        }

        const sortDir = String(req.query.sortDir || 'desc') === 'asc' ? 'asc' : 'desc';

        const [transactions, total] = await Promise.all([
            prisma.transaction.findMany({
                where,
                orderBy: { createdAt: sortDir },
                skip,
                take: limit
            }),
            prisma.transaction.count({ where })
        ]);

        return res.json({
            success: true,
            data: transactions,
            meta: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            error: {
                code: 'TRANSACTIONS_ERROR',
                message: 'Erro ao listar transações.'
            }
        });
    }
};

export const getTransaction = async (req: AuthRequest, res: Response) => {
    try {
        const merchantId = req.user?.id || (req as any).merchantId;
        
        if (!merchantId) {
            return res.status(401).json({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' }
            });
        }

        const transaction = await prisma.transaction.findFirst({
            where: {
                id: String(req.params.id), // CORREÇÃO TYPESCRIPT AQUI
                merchantId: String(merchantId)
            }
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Transação não encontrada.'
                }
            });
        }

        return res.json({
            success: true,
            data: transaction
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            error: {
                code: 'TRANSACTION_ERROR',
                message: 'Erro ao carregar transação.'
            }
        });
    }
};

export const getTransactionStats = async (req: AuthRequest, res: Response) => {
    try {
        const merchantId = req.user?.id || (req as any).merchantId;
        
        if (!merchantId) {
            return res.status(401).json({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' }
            });
        }

        const safeMerchantId = String(merchantId);

        const [
            total,
            approved,
            failed,
            pending,
            volume
        ] = await Promise.all([
            prisma.transaction.count({ where: { merchantId: safeMerchantId } }),
            prisma.transaction.count({ where: { merchantId: safeMerchantId, status: 'succeeded' } }),
            prisma.transaction.count({ where: { merchantId: safeMerchantId, status: 'failed' } }),
            prisma.transaction.count({ where: { merchantId: safeMerchantId, status: 'pending' } }),
            prisma.transaction.aggregate({
                where: { merchantId: safeMerchantId, status: 'succeeded' },
                _sum: { amount: true }
            })
        ]);

        return res.json({
            success: true,
            data: {
                total,
                approved,
                failed,
                pending,
                successRate: total === 0 ? 100 : Number(((approved / total) * 100).toFixed(2)),
                volume: Number(volume._sum?.amount || 0) // Prevenção de erro caso não haja soma
            }
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            error: {
                code: 'TRANSACTION_STATS_ERROR',
                message: 'Erro ao carregar estatísticas.'
            }
        });
    }
};
