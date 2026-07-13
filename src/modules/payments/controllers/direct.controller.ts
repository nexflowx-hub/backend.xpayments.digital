import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const prisma = new PrismaClient();

export const processDirectCharge = async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const { amount, currency, payment_method_types, metadata = {} } = payload;
    
    const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: { message: "API Key não fornecida." } });

    const keyRecord = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      include: { store: { include: { gatewayVaults: true } } }
    });

    if (!keyRecord || keyRecord.store.status !== 'active') {
      return res.status(401).json({ error: { message: "Chave inválida ou Loja inativa." } });
    }

    const store = keyRecord.store;
    const merchantReference = metadata.order_id || `REQ-${Date.now()}`;
    const requestedMethod = payment_method_types?.[0] || 'unknown';

    const routingRules = (store.routingRules as Record<string, string>) || {};
    const targetProvider = routingRules[requestedMethod];

    let gatewayVault = null;
    if (targetProvider) {
      gatewayVault = store.gatewayVaults.find(v => v.provider.toLowerCase() === targetProvider.toLowerCase() && v.isActive);
    }
    
    if (!gatewayVault) {
      gatewayVault = store.gatewayVaults.find(v => v.isActive);
    }

    if (!gatewayVault) {
      return res.status(400).json({ error: { message: `Nenhum provedor configurado para processar ${requestedMethod}.` } });
    }

    const transaction = await prisma.transaction.create({
      data: {
        merchantId: store.merchantId,
        storeId: store.id,
        gatewayVaultId: gatewayVault.id,
        reference: merchantReference,
        amount: amount,
        currency: currency,
        status: 'pending',
        method: requestedMethod,
        gateway: gatewayVault.provider,
        rawRequest: JSON.parse(JSON.stringify(payload)) 
      }
    });

    if (gatewayVault.provider.toLowerCase() === 'stripe') {
      const credentials = gatewayVault.credentials as any;
      if (!credentials.secretKey) {
        return res.status(500).json({ error: { message: "Gateway Vault da Stripe mal configurado." } });
      }

      // Correção: Versão exata exigida pelo SDK e reconhecida pela Stripe
      const stripeClient = new Stripe(credentials.secretKey, { apiVersion: '2026-06-24.dahlia' as any });

      const stripePayload: Stripe.PaymentIntentCreateParams = {
        amount,
        currency: currency.toLowerCase(),
        payment_method_types,
        metadata: {
          ...metadata,
          nexflowx_transaction_id: transaction.id, 
          nexor_reference: merchantReference
        }
      };

      const paymentIntent = await stripeClient.paymentIntents.create(stripePayload);

      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          providerId: paymentIntent.id,
          rawResponse: JSON.parse(JSON.stringify(paymentIntent))
        }
      });

      return res.status(200).json(paymentIntent);
    }

    return res.status(400).json({ error: { message: `Provedor ${gatewayVault.provider} ainda não integrado.` } });

  } catch (error: any) {
    console.error('[DIRECT API ERROR]:', error);
    return res.status(500).json({ error: { message: error.message || "Erro interno." } });
  }
};
