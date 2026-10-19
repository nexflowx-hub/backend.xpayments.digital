import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../core/config/security';

export interface AuthRequest extends Request {
  user?: any;
  merchantId?: string;
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Token não fornecido ou formato inválido.'
      }
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    (req as any).user = decoded;
    (req as any).merchantId = decoded?.id;
    return next();
  } catch (error) {
    const configurationError =
      error instanceof Error && error.message.startsWith('JWT_SECRET must be configured');

    if (configurationError) {
      console.error('[AUTH_CONFIGURATION_ERROR]', error);
      return res.status(503).json({
        success: false,
        error: {
          code: 'AUTH_CONFIGURATION_ERROR',
          message: 'Serviço de autenticação indisponível.'
        }
      });
    }

    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Token inválido ou expirado.'
      }
    });
  }
};
