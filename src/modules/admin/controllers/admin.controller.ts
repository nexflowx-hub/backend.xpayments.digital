import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

const generateKey = (env: 'test' | 'live'): string => {
    const randomPart = randomBytes(9).toString('base64url');
    return `xp_${env}_${randomPart}`;
};

export const getMerchants = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const updateMerchantStatus = async (req: AuthRequest, res: Response) => res.json({ success: true });
export const getKycReviews = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const approveKyc = async (req: AuthRequest, res: Response) => res.json({ success: true });
export const rejectKyc = async (req: AuthRequest, res: Response) => res.json({ success: true });
export const getTreasuryOverview = async (req: AuthRequest, res: Response) => res.json({
  success: true, data: { totalBalance: 0, availableBalance: 0, reservedBalance: 0, currency: 'EUR', liquidity: [], settlements: [], cashflow: [] }
});
export const getRevenue = async (req: AuthRequest, res: Response) => res.json({ success: true, data: { total: 0, series: [] } });
export const getHealth = async (req: AuthRequest, res: Response) => res.json({ success: true, data: { status: 'healthy', uptime: 100, workers: [], queues: [], incidents: [] } });

// Novo endpoint de Geração de Chaves
export const generateApiKey = async (req: AuthRequest, res: Response) => {
    try {
        const { storeId, environment, name } = req.body;
        
        if (!storeId || !environment) {
            return res.status(400).json({ success: false, message: "storeId e environment são obrigatórios." });
        }

        const env = environment === 'live' ? 'live' : 'test';
        const newKey = generateKey(env);

        const apiKey = await prisma.apiKey.create({
            data: {
                storeId,
                key: newKey,
                environment: env,
                name: name || `API Key ${env.toUpperCase()}`,
                scopes: ['payments_write']
            }
        });

        return res.status(201).json({ success: true, key: newKey, data: apiKey });
    } catch (error: any) {
        return res.status(500).json({ success: false, message: error.message });
    }
};
