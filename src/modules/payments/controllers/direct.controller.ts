import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const processDirectCharge = async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const { amount, currency, payment_method_types, metadata = {} } = payload;
    
    // 1. Identificar a Store e o Merchant diretamente pela API Key (sem hashes)
    const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: { message: "API Key não fornecida." } });

    const keyRecord = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      include: { 
        store: { 
          include: { gatewayVaults: true } 
        } 
      }
    });

    if (!keyRecord || keyRecord.store.status !== 'active') {
      return res.status(401).json({ error: { message: "Chave inválida ou Loja inativa." } });
    }

    const store = keyRecord.store;
    const merchantReference = metadata.order_id || `REQ-${Date.now()}`;
    const requestedMethod = payment_method_types?.[0] || 'unknown';

    // 2. Roteamento Inteligente (Smart Routing via JSON)
    const routingRules = (store.routingRules as Record<string, string>) || {};
    const targetProvider = routingRules[requestedMethod]; // Ex: "STRIPE_PT_002"

    let gatewayVault = null;
    if (targetProvider) {
      gatewayVault = store.gatewayVaults.find(v => v.provider === targetProvider && v.isActive);
    }
    
    // Fallback: Se não houver regra específica para este método, usa o primeiro cofre ativo
    if (!gatewayVault) {
      gatewayVault = store.gatewayVaults.find(v => v.isActive);
    }

    if (!gatewayVault) {
      return res.status(400).json({ error: { message: `Nenhum provedor configurado para processar ${requestedMethod}.` } });
    }

    // 3. Criar Transação (Intenção de Pagamento)
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

    // 4. Encaminhamento para o Provider
    // (No futuro, aqui entra um Switch Case para Stripe, Misticpay, SIBS, etc.)
    const stripePayload = {
      ...payload,
      metadata: {
        ...metadata,
        nexflowx_transaction_id: transaction.id,
        nexor_reference: merchantReference
      }
    };

    const isAsyncMethod = ['multibanco', 'mb_way', 'pix'].includes(requestedMethod);
    
    // Simulação da Resposta do Provider
    const providerResponse = {
      id: `pi_simulado_${Date.now()}`,
      object: "payment_intent",
      amount: amount,
      currency: currency,
      status: isAsyncMethod ? "requires_action" : "succeeded",
      payment_method_types: payment_method_types,
      metadata: stripePayload.metadata,
      next_action: isAsyncMethod ? {
        type: `${requestedMethod}_display_details`,
        details: { entity: "12345", reference: "987654321", expires_at: Math.floor(Date.now() / 1000) + 86400 }
      } : null
    };

    // 5. Atualizar Transação com a Resposta
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        providerId: providerResponse.id,
        status: providerResponse.status === 'succeeded' ? 'succeeded' : 'pending',
        rawResponse: providerResponse 
      }
    });

    return res.status(200).json(providerResponse);

  } catch (error: any) {
    console.error('[DIRECT API ERROR]:', error);
    return res.status(500).json({ error: { message: "Erro interno no motor de orquestração." } });
  }
};
