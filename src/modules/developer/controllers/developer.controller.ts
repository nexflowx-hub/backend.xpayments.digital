import { Response } from 'express';
import crypto from 'crypto';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const getApiKeys = async (req: AuthRequest, res: Response) => {

    const stores = await prisma.store.findMany({
        where: {
            merchantId: req.user.id
        },
        select: {
            id: true
        }
    });

    const storeIds = stores.map(s => s.id);

    const keys = await prisma.apiKey.findMany({

        where: {
            storeId: {
                in: storeIds
            }
        },

        orderBy: {
            createdAt: 'desc'
        }

    });

    res.json({
        success: true,
        data: keys
    });

};

export const createApiKey = async (req: AuthRequest, res: Response) => {

    const {

        storeId,
        name,
        scopes,
        environment

    } = req.body;

    const store = await prisma.store.findFirst({

        where: {

            id: storeId,
            merchantId: req.user.id

        }

    });

    if (!store) {

        return res.status(404).json({

            success: false,
            error: {

                message: 'Store não encontrada.'

            }

        });

    }

    const key =

        'sk_' +

        crypto.randomBytes(32).toString('hex');

    const apiKey = await prisma.apiKey.create({

        data: {

            storeId,

            name,

            key,

            scopes: scopes || ['payments'],

            environment: environment || 'test'

        }

    });

    res.json({

        success: true,

        data: {

            ...apiKey,

            fullKey: key

        }

    });

};

export const deleteApiKey = async (req: AuthRequest, res: Response) => {

    await prisma.apiKey.delete({

        where: {

            id: String(req.params.id)

        }

    });

    res.json({

        success: true

    });

};

export const getWebhooks = async (req: AuthRequest, res: Response) => {

    const stores = await prisma.store.findMany({

        where: {

            merchantId: req.user.id

        },

        select: {

            id: true

        }

    });

    const hooks = await prisma.webhook.findMany({

        where: {

            storeId: {

                in: stores.map(s => s.id)

            }

        },

        orderBy: {

            createdAt: 'desc'

        }

    });

    res.json({

        success: true,

        data: hooks

    });

};

export const createWebhook = async (req: AuthRequest, res: Response) => {

    const {

        storeId,
        url,
        events

    } = req.body;

    const webhook = await prisma.webhook.create({

        data: {

            storeId,

            url,

            events,

            secret: crypto.randomBytes(24).toString('hex')

        }

    });

    res.json({

        success: true,

        data: webhook

    });

};

export const deleteWebhook = async (req: AuthRequest, res: Response) => {

    await prisma.webhook.delete({

        where: {

            id: String(req.params.id)

        }

    });

    res.json({

        success: true

    });

};
