import { Response } from 'express';

export function failure(
    res: Response,
    code: string,
    message: string,
    status = 400
) {
    return res.status(status).json({
        success: false,
        error: {
            code,
            message
        }
    });
}
