import crypto from 'crypto';
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import prisma from '../../../core/prisma';

const RESET_TTL = '30m';
const RESET_ISSUER = 'xpayments.digital';
const RESET_AUDIENCE = 'password-reset';

const getJwtSecret = (): string => {
  const secret = String(process.env.JWT_SECRET ?? '').trim();
  if (!secret) throw new Error('JWT_SECRET_NOT_CONFIGURED');
  return secret;
};

const passwordFingerprint = (passwordHash: string) =>
  crypto.createHash('sha256').update(passwordHash).digest('hex').slice(0, 32);

const publicAppUrl = () => {
  const configured = String(process.env.XPAYMENTS_APP_URL ?? 'https://xpayments.digital').trim();
  return configured || 'https://xpayments.digital';
};

const buildResetUrl = (token: string) => {
  const url = new URL('/reset-password', publicAppUrl());
  url.searchParams.set('token', token);
  return url.toString();
};

const sendPasswordResetEmail = async (
  email: string,
  merchantName: string,
  resetUrl: string
): Promise<boolean> => {
  const apiKey = String(process.env.RESEND_API_KEY ?? '').trim();
  const from = String(process.env.XPAYMENTS_MAIL_FROM ?? '').trim();

  if (!apiKey || !from) {
    console.warn('[PASSWORD_RESET_EMAIL_NOT_CONFIGURED]', {
      provider: 'resend',
      apiKeyConfigured: Boolean(apiKey),
      fromConfigured: Boolean(from)
    });
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Redefinir palavra-passe XPayments',
        text: [
          `Olá ${merchantName || 'Merchant'},`,
          '',
          'Recebemos um pedido para redefinir a palavra-passe da sua conta XPayments.',
          'Abra o link abaixo. O link expira em 30 minutos:',
          resetUrl,
          '',
          'Se não fez este pedido, ignore esta mensagem.'
        ].join('\n')
      })
    });

    if (!response.ok) {
      console.error('[PASSWORD_RESET_EMAIL_ERROR]', { status: response.status });
      return false;
    }

    return true;
  } catch (error) {
    console.error('[PASSWORD_RESET_EMAIL_ERROR]', {
      message: error instanceof Error ? error.message : 'unknown error'
    });
    return false;
  }
};

export const forgotPassword = async (req: Request, res: Response) => {
  const genericResponse = {
    success: true,
    message: 'Se existir uma conta com este email, enviaremos instruções para redefinir a palavra-passe.'
  };

  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return res.status(202).json(genericResponse);
    }

    const merchant = await prisma.merchant.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        status: true
      }
    });

    if (!merchant || merchant.status !== 'active') {
      return res.status(202).json(genericResponse);
    }

    const token = jwt.sign(
      {
        purpose: 'password_reset',
        ph: passwordFingerprint(merchant.passwordHash)
      },
      getJwtSecret(),
      {
        subject: merchant.id,
        expiresIn: RESET_TTL,
        issuer: RESET_ISSUER,
        audience: RESET_AUDIENCE
      }
    );

    await sendPasswordResetEmail(merchant.email, merchant.name, buildResetUrl(token));

    return res.status(202).json(genericResponse);
  } catch (error) {
    console.error('[PASSWORD_RESET_REQUEST_ERROR]', {
      message: error instanceof Error ? error.message : 'unknown error'
    });
    return res.status(202).json(genericResponse);
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  try {
    const token = String(req.body?.token ?? '').trim();
    const password = String(req.body?.password ?? '');

    if (!token) {
      return res.status(400).json({ success: false, error: { code: 'RESET_TOKEN_REQUIRED', message: 'Token de redefinição obrigatório.' } });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PASSWORD', message: 'A nova palavra-passe deve ter entre 8 e 128 caracteres.' } });
    }

    let decoded: jwt.JwtPayload;

    try {
      decoded = jwt.verify(token, getJwtSecret(), {
        issuer: RESET_ISSUER,
        audience: RESET_AUDIENCE
      }) as jwt.JwtPayload;
    } catch {
      return res.status(400).json({ success: false, error: { code: 'RESET_TOKEN_INVALID_OR_EXPIRED', message: 'O link de redefinição é inválido ou expirou.' } });
    }

    if (decoded.purpose !== 'password_reset' || typeof decoded.sub !== 'string' || typeof decoded.ph !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'RESET_TOKEN_INVALID_OR_EXPIRED', message: 'O link de redefinição é inválido ou expirou.' } });
    }

    const merchant = await prisma.merchant.findUnique({
      where: { id: decoded.sub },
      select: { id: true, passwordHash: true, status: true }
    });

    if (!merchant || merchant.status !== 'active' || passwordFingerprint(merchant.passwordHash) !== decoded.ph) {
      return res.status(400).json({ success: false, error: { code: 'RESET_TOKEN_INVALID_OR_EXPIRED', message: 'O link de redefinição é inválido ou expirou.' } });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash } });

    console.info('[PASSWORD_RESET_COMPLETED]', { merchantId: merchant.id });

    return res.status(200).json({
      success: true,
      message: 'Palavra-passe redefinida com sucesso. Pode iniciar sessão com a nova palavra-passe.'
    });
  } catch (error) {
    console.error('[PASSWORD_RESET_ERROR]', {
      message: error instanceof Error ? error.message : 'unknown error'
    });
    return res.status(500).json({ success: false, error: { code: 'PASSWORD_RESET_ERROR', message: 'Não foi possível redefinir a palavra-passe.' } });
  }
};
