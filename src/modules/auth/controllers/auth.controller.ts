import crypto from 'crypto';
import { Request, Response } from 'express';
import prisma from '../../../core/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';
interface AuthRequest extends Request { user?: any; }

const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();

const generatePagarPixStoreCode = () =>
  `PAGARPIX-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

export const login = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    const merchant = email
      ? await prisma.merchant.findUnique({ where: { email } })
      : null;

    if (!merchant || !(await bcrypt.compare(password, merchant.passwordHash))) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Credenciais inválidas' } });
    }

    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });

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
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
};

export const register = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    const name = String(req.body?.name ?? '').trim();
    const companyName = String(req.body?.companyName ?? '').trim();
    if (!email || !password || !name) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Faltam dados obrigatórios.' } });

    const existingMerchant = await prisma.merchant.findUnique({ where: { email } });
    if (existingMerchant) return res.status(400).json({ success: false, error: { code: 'CONFLICT', message: 'Este email já está registado.' } });

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

    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });

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
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
};

export const registerPagarPix = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    const name = String(req.body?.name ?? '').trim();
    const companyName = String(req.body?.companyName ?? '').trim();
    const storeNameInput = String(req.body?.storeName ?? '').trim();

    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'Informe um e-mail válido.' } });
    }
    if (name.length < 2 || name.length > 120) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_NAME', message: 'Informe o nome do responsável.' } });
    }
    if (password.length < 10 || password.length > 256) {
      return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'A senha deve ter pelo menos 10 caracteres.' } });
    }
    if (companyName.length > 160 || storeNameInput.length > 120) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Dados empresariais inválidos.' } });
    }

    const existingMerchant = await prisma.merchant.findUnique({
      where: { email },
      select: { id: true }
    });
    if (existingMerchant) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ACCOUNT_EXISTS',
          message: 'Já existe uma conta com este e-mail. Entre no PagarPIX com as credenciais existentes.'
        }
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const storeName = storeNameInput || companyName || `${name} BRL`;

    const result = await prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.create({
        data: {
          email,
          name,
          company: companyName || null,
          passwordHash,
          status: 'active'
        }
      });

      const wallet = await tx.wallet.create({
        data: {
          merchantId: merchant.id,
          currency: 'BRL',
          label: 'PagarPIX Conta BRL',
          type: 'fiat'
        }
      });

      const store = await tx.store.create({
        data: {
          merchantId: merchant.id,
          storeCode: generatePagarPixStoreCode(),
          name: storeName,
          status: 'draft',
          currency: 'BRL',
          routingRules: {
            _config: {
              product: 'pagarpix',
              onboardingMode: 'self_service',
              processingState: 'awaiting_activation'
            }
          }
        }
      });

      return { merchant, wallet, store };
    });

    const token = jwt.sign(
      { id: result.merchant.id, role: 'merchant', productContext: 'pagarpix' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      success: true,
      data: {
        token,
        account: {
          product: 'pagarpix',
          activation: 'awaiting_activation'
        },
        merchant: {
          id: result.merchant.id,
          name: result.merchant.name,
          email: result.merchant.email
        },
        wallet: {
          id: result.wallet.id,
          currency: result.wallet.currency
        },
        store: {
          id: result.store.id,
          storeCode: result.store.storeCode,
          name: result.store.name,
          currency: result.store.currency,
          status: result.store.status
        }
      }
    });
  } catch (error) {
    console.error('[PAGARPIX_REGISTER_ERROR]', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Não foi possível criar a conta PagarPIX.' }
    });
  }
};

export const me = async (req: AuthRequest, res: Response) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.user.id } });
    if (!merchant) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Comerciante não encontrado.' } });

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

export const logout = (req: Request, res: Response) => res.status(200).json({ success: true, data: { message: 'Sessão terminada.' } });
