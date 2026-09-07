import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { executePayment } from '../../payments/services/payment.service';
import crypto from 'crypto';

const prisma = new PrismaClient();

const PAYMENT_LABELS: Record<string, string> = {
  card: 'Cartão',
  mb_way: 'MB WAY',
  multibanco: 'Multibanco',
  bizum: 'Bizum',
  pix: 'PIX',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  bancontact: 'Bancontact',
  blik: 'BLIK',
  ideal: 'iDEAL',
  eps: 'EPS',
  klarna: 'Klarna',
  amazon_pay: 'Amazon Pay'
};

export const createSession = async (req: Request, res: Response) => {
  try {
    const { amount, currency = 'EUR', reference, customerEmail, metadata } = req.body;
    const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;

    if (!apiKey) {
      return res.status(401).json({ success: false, message: 'API Key não fornecida.' });
    }

    const keyRecord = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      include: { store: true }
    });

    if (!keyRecord || keyRecord.store.status !== 'active') {
      return res.status(401).json({ success: false, message: 'Acesso negado.' });
    }

    const amountInEur = Number(amount) / 100;
    const sessionId = crypto.randomUUID();
    const checkoutUrl = `https://checkout.xpayments.digital/pay/${sessionId}`;

    const session = await prisma.checkoutSession.create({
      data: {
        id: sessionId,
        merchantId: keyRecord.store.merchantId,
        storeId: keyRecord.store.id,
        amount: amountInEur,
        checkoutUrl,
        currency,
        reference: reference || `CHK-${Date.now()}`,
        customerEmail,
        metadata: metadata || {},
        status: 'pending',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        sessionId: session.id,
        checkoutUrl: session.checkoutUrl,
        storeCode: keyRecord.store.storeCode,
        expiresAt: session.expiresAt.toISOString()
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Erro interno.' });
  }
};

export const loadSession = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId);
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: { store: true }
    });

    if (!session) {
      return res.status(404).json({ success: false, message: 'Sessão não encontrada.' });
    }

    const store = (session as any).store;
    const routingRules = (store?.routingRules as Record<string, unknown>) || {};

    // routing_rules also carries orchestration/config metadata in some Stores.
    // Only documented payment-method keys may be exposed as checkout methods.
    const paymentMethods = Object.keys(PAYMENT_LABELS)
      .filter(code => typeof routingRules[code] === 'string' && String(routingRules[code]).trim().length > 0)
      .map(code => ({
        code,
        label: PAYMENT_LABELS[code],
        provider: String(routingRules[code])
      }));

    const config =
      routingRules._config && typeof routingRules._config === 'object'
        ? routingRules._config as Record<string, unknown>
        : {};

    return res.status(200).json({
      success: true,
      data: {
        sessionId: session.id,
        storeId: session.storeId,
        storeCode: store?.storeCode || null,
        storeName: store?.name || 'Store',
        amount: Number(session.amount),
        currency: session.currency,
        reference: session.reference,
        status: session.status,
        customerEmail: session.customerEmail ?? null,
        metadata: session.metadata ?? {},
        expiresAt: session.expiresAt?.toISOString?.() ?? session.expiresAt,
        checkoutUrl: session.checkoutUrl ?? null,
        returnUrl: typeof config.successUrl === 'string' ? config.successUrl : null,
        primaryColor: typeof config.primaryColor === 'string' ? config.primaryColor : null,
        logoUrl: store?.logoUrl || null,
        theme: store?.theme || 'light',
        paymentMethods
      }
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Erro interno.' });
  }
};

export const initiatePayment = async (req: Request, res: Response) => {
  try {
    const { sessionId, paymentMethod, customer } = req.body;

    if (!sessionId || !paymentMethod) {
      return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    const session = await prisma.checkoutSession.findUnique({
      where: { id: String(sessionId) }
    });

    if (!session) {
      return res.status(404).json({ success: false, message: 'Sessão inválida.' });
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      if (session.status !== 'succeeded') {
        await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: 'expired' }
        });
      }
      return res.status(410).json({ success: false, message: 'Sessão expirada.' });
    }

    if (session.status === 'succeeded') {
      return res.status(409).json({ success: false, message: 'Esta sessão já foi paga.' });
    }

    const result = await executePayment({
      amount: Number(session.amount) * 100,
      currency: session.currency,
      paymentMethod,
      storeId: session.storeId,
      metadata: {
        ...(session.metadata as object),
        customerEmail: session.customerEmail,
        ...customer
      },
      merchantReference: session.reference || `CHK-${session.id}`
    });

    if (session.status === 'pending') {
      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'processing' }
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error(error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Erro ao iniciar pagamento.'
    });
  }
};
