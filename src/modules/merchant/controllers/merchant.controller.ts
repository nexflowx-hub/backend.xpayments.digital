import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const parseThemeConfig = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        const mode = value === 'dark' ? 'dark' : 'light';
        return { mode };
    }
};

const validHttpsUrl = (value: unknown): string | null | undefined => {
    if (value === null || value === '') return null;
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
};

export const getProfile = async (req: AuthRequest, res: Response) => {
    try {
        const merchantId = req.user?.id;
        if (!merchantId) {
            return res.status(401).json({ success: false, error: { message: 'Merchant não autenticado.' } });
        }

        const merchant = await prisma.merchant.findUnique({
            where: { id: merchantId },
            include: { stores: true, wallets: true }
        });

        if (!merchant) {
            return res.status(404).json({ success: false, error: { message: 'Merchant não encontrado.' } });
        }

        return res.json({ success: true, data: merchant });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: { message: 'Erro interno.' } });
    }
};

export const getStores = async (req: AuthRequest, res: Response) => {
    try {
        const merchantId = req.user?.id;
        if (!merchantId) return res.status(401).json({ success: false });

        const stores = await prisma.store.findMany({
            where: { merchantId },
            orderBy: { createdAt: 'asc' }
        });

        return res.json({ success: true, data: stores });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false });
    }
};

export const getStore = async (req: AuthRequest, res: Response) => {
    try {
        const merchantId = req.user?.id;
        if (!merchantId) return res.status(401).json({ success: false });

        const storeId = Array.isArray((req.params as any).id)
            ? (req.params as any).id[0]
            : (req.params as any).id;

        const store = await prisma.store.findFirst({
            where: { id: storeId, merchantId },
            include: { apiKeys: true, webhooks: true, gatewayVaults: true }
        });

        if (!store) {
            return res.status(404).json({ success: false, error: { message: 'Loja não encontrada.' } });
        }

        const checkoutBranding = {
            ...parseThemeConfig(store.theme),
            logoUrl: store.logoUrl || null
        };

        return res.json({
            success: true,
            data: {
                ...store,
                checkoutBranding
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: { message: 'Erro interno.' } });
    }
};

export const updateCheckoutBranding = async (req: AuthRequest, res: Response) => {
    try {
        const merchantId = req.user?.id;
        if (!merchantId) return res.status(401).json({ success: false });

        const storeId = Array.isArray((req.params as any).id)
            ? (req.params as any).id[0]
            : (req.params as any).id;

        const store = await prisma.store.findFirst({
            where: { id: storeId, merchantId }
        });

        if (!store) {
            return res.status(404).json({ success: false, error: { message: 'Loja não encontrada.' } });
        }

        const body = req.body || {};
        const current = parseThemeConfig(store.theme);

        const displayName = String(body.checkoutDisplayName ?? current.checkoutDisplayName ?? store.name).trim();
        if (displayName.length < 2 || displayName.length > 80) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_CHECKOUT_DISPLAY_NAME', message: 'O nome público deve ter entre 2 e 80 caracteres.' }
            });
        }

        const primaryColor = String(body.primaryColor ?? current.primaryColor ?? '#111111').trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_PRIMARY_COLOR', message: 'Cor principal inválida. Use #RRGGBB.' }
            });
        }

        const requestedMode = String(body.mode ?? current.mode ?? 'light').toLowerCase();
        const mode = ['light', 'dark', 'system'].includes(requestedMode) ? requestedMode : 'light';
        const autoReturnSeconds = Math.min(10, Math.max(0, Number(body.autoReturnSeconds ?? current.autoReturnSeconds ?? 3)));
        const logoUrl = validHttpsUrl(body.logoUrl ?? store.logoUrl);

        if (logoUrl === undefined) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_LOGO_URL', message: 'O logo deve usar uma URL HTTPS válida.' }
            });
        }

        const config = {
            version: 1,
            mode,
            checkoutDisplayName: displayName,
            primaryColor,
            autoReturnSeconds,
            localeMode: 'auto'
        };

        const updated = await prisma.store.update({
            where: { id: store.id },
            data: {
                theme: JSON.stringify(config),
                logoUrl
            }
        });

        return res.json({
            success: true,
            data: {
                storeId: updated.id,
                storeCode: updated.storeCode,
                checkoutBranding: {
                    ...config,
                    logoUrl: updated.logoUrl || null
                }
            }
        });
    } catch (error) {
        console.error('[merchant.updateCheckoutBranding]', error);
        return res.status(500).json({ success: false, error: { message: 'Erro interno.' } });
    }
};
