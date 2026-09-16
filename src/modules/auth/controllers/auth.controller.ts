import { Request, Response } from 'express';
import prisma from '../../../core/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../../../core/config/security';

interface AuthRequest extends Request { user?: any; }

const authConfigurationFailure = (res: Response, error: unknown) => {
  console.error('[AUTH_CONFIGURATION_ERROR]', error);
  return res.status(503).json({
    success: false,
    error: {
      code: 'AUTH_CONFIGURATION_ERROR',
      message: 'Serviço de autenticação indisponível.'
    }
  });
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const merchant = await prisma.merchant.findUnique({ where: { email } });

    if (!merchant || !(await bcrypt.compare(password, merchant.passwordHash))) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Credenciais inválidas' } });
    }

    const token = jwt.sign(
      { id: merchant.id, role: 'merchant' },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      success: true,
      data: {
        token,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email
        }
      }
    });
  } catch (error: any) {
    if (error instanceof Error && error.message.startsWith('JWT_SECRET must be configured')) {
      return authConfigurationFailure(res, error);
    }
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
};

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, name, companyName } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Faltam dados obrigatórios.' } });
    }

    const existingMerchant = await prisma.merchant.findUnique({ where: { email } });
    if (existingMerchant) {
      return res.status(400).json({ success: false, error: { code: 'CONFLICT', message: 'Este email já está registado.' } });
    }

    /* Validate configuration before mutating data. */
    const jwtSecret = getJwtSecret();
    const passwordHash = await bcrypt.hash(password, 10);
    const merchant = await prisma.$transaction(async (tx) => {
      const newMerchant = await tx.merchant.create({
        data: { email, name, company: companyName || '', passwordHash, status: 'active' }
      });
      await tx.wallet.create({
        data: { merchantId: newMerchant.id, currency: 'EUR', label: 'Conta Principal (EUR)', type: 'fiat' }
      });
      return newMerchant;
    });

    const token = jwt.sign(
      { id: merchant.id, role: 'merchant' },
      jwtSecret,
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      success: true,
      data: {
        token,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email
        }
      }
    });
  } catch (error: any) {
    if (error instanceof Error && error.message.startsWith('JWT_SECRET must be configured')) {
      return authConfigurationFailure(res, error);
    }
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
};

export const me = async (req: AuthRequest, res: Response) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.user.id } });
    if (!merchant) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Comerciante não encontrado.' } });
    }

    return res.status(200).json({
      success: true,
      data: {
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email
        }
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
};

export const logout = (req: Request, res: Response) =>
  res.status(200).json({ success: true, data: { message: 'Sessão terminada.' } });
