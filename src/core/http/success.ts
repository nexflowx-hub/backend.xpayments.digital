import { Response } from 'express';

export function success(
    res: Response,
    data: any = null,
    meta: any = null,
    message: string | null = null,
    status = 200
) {
    return res.status(status).json({
        success: true,
        data,
        meta,
        message
    });
}
