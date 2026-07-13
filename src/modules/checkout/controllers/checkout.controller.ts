import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// FASE 1: CRIAR SESSÃO
export const createSession = async (req: Request, res: Response) => {
  try {
    const { amount, currency = 'EUR', reference, customerEmail, metadata } = req.body;
    const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;

    if (!apiKey) return res.status(401).json({ success: false, message: "API Key não fornecida." });

    const keyRecord = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      include: { store: true }
    });

    if (!keyRecord || keyRecord.store.status !== 'active') {
      return res.status(401).json({ success: false, message: "Acesso negado." });
    }

    const session = await prisma.checkoutSession.create({
      data: {
        merchantId: keyRecord.store.merchantId,
        storeId: keyRecord.store.id,
        amount: amount,
        currency: currency,
        reference: reference || `CHK-${Date.now()}`,
        customerEmail: customerEmail,
        status: 'pending',
        metadata: metadata || {},
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        sessionId: session.id,
        checkoutUrl: `https://checkout.xpayments.digital/pay/${session.id}`,
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro interno." });
  }
};

// FASE 2: CARREGAR SESSÃO
export const loadSession = async (req: Request, res: Response) => {
  try {
    // Forçamos o cast para string para resolver o erro TS2322
    const sessionId = req.params.sessionId as string;

    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: { store: true } // Garante que a relação existe no TS
    });

    if (!session) return res.status(404).json({ success: false, message: "Sessão não encontrada." });
    
    // Acesso seguro à relação store
    const store = session.store; 

    return res.status(200).json({
      success: true,
      data: {
        sessionId: session.id,
        storeName: store ? store.name : 'Unknown Store',
        amount: session.amount,
        currency: session.currency,
        reference: session.reference
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro interno." });
  }
};
