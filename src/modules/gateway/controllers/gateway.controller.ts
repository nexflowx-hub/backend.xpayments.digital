import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

export const listGateways = async (req: AuthRequest, res: Response) => {

    const gateways = await prisma.gatewayVault.findMany({

        where: {
            merchantId: req.user.id
        },

        orderBy: {
            createdAt: 'desc'
        }

    });

    res.json({
        success: true,
        data: gateways
    });

};

export const getGateway = async (req: AuthRequest, res: Response) => {

    const gateway = await prisma.gatewayVault.findFirst({

        where: {

            id: String(req.params.id),
            merchantId: req.user.id

        }

    });

    if (!gateway) {

        return res.status(404).json({

            success: false,

            error: {
                message: 'Gateway não encontrado.'
            }

        });

    }

    res.json({

        success: true,

        data: gateway

    });

};

export const createGateway = async (req: AuthRequest, res: Response) => {

    const {

        storeId,
        provider,
        credentials,
        isActive

    } = req.body;

    const gateway = await prisma.gatewayVault.create({

        data: {

            merchantId: req.user.id,

            storeId: storeId || null,

            provider,

            credentials,

            isActive: isActive ?? true

        }

    });

    res.status(201).json({

        success: true,

        data: gateway

    });

};

export const updateGateway = async (req: AuthRequest, res: Response) => {

    const existing = await prisma.gatewayVault.findFirst({

        where: {

            id: String(req.params.id),

            merchantId: req.user.id

        }

    });

    if (!existing) {

        return res.status(404).json({

            success: false,

            error: {
                message: 'Gateway não encontrado.'
            }

        });

    }

    const gateway = await prisma.gatewayVault.update({

        where: {

            id: String(req.params.id)

        },

        data: req.body

    });

    res.json({

        success: true,

        data: gateway

    });

};

export const deleteGateway = async (req: AuthRequest, res: Response) => {

    await prisma.gatewayVault.delete({

        where: {

            id: String(req.params.id)

        }

    });

    res.json({

        success: true

    });

};
