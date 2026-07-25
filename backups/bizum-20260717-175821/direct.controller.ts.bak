import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const prisma = new PrismaClient();

function normalizePhone(phone: string): string | null {
    if (!phone) return null;
    let cleaned = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
    if (!cleaned.startsWith('+')) {
        if (cleaned.startsWith('00')) cleaned = '+' + cleaned.substring(2);
        else if (cleaned.length === 9) cleaned = '+351' + cleaned;
        else if (cleaned.length > 9) cleaned = '+' + cleaned;
    }
    return cleaned.length > 8 ? cleaned : null;
}

function parseRoutingRules(rules: any): Record<string, string> {
    try {
        if (typeof rules === 'string') return JSON.parse(rules.replace(/\\"/g, '"').replace(/^"|"$/g, ''));
        return rules || {};
    } catch { return {}; }
}

export const processDirectCharge = async (req: Request, res: Response) => {
  try {
    const { amount, currency, payment_method_types, metadata = {}, customer = {} } = req.body;
    const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;

    if (!apiKey) return res.status(401).json({ error: { message: "API Key não fornecida." } });

    const keyRecord = await prisma.apiKey.findUnique({ where: { key: apiKey }, include: { store: true } });
    if (!keyRecord || keyRecord.store.status !== 'active') return res.status(401).json({ error: { message: "Acesso negado." } });

    const store = keyRecord.store;
    const merchantReference = metadata.order_id || `REQ-${Date.now()}`;
    const rawMethod = payment_method_types?.[0] || 'card';

    let transaction = await prisma.transaction.findFirst({
        where: { merchantId: store.merchantId, reference: merchantReference }
    });

    if (transaction && transaction.status === 'succeeded') {
        return res.status(400).json({ error: { message: "Transação já paga." } });
    }

    const availableVaults = await prisma.gatewayVault.findMany({
        where: { merchantId: store.merchantId, isActive: true, OR: [{ storeId: null }, { storeId: store.id }] }
    });

    const routingRules = parseRoutingRules(store.routingRules);
    const targetProvider = routingRules[rawMethod];
    let gatewayVault = targetProvider ? availableVaults.find(v => v.provider.toLowerCase() === targetProvider.toLowerCase()) : availableVaults[0];

    if (!gatewayVault) return res.status(400).json({ error: { message: `Nenhum provedor para ${rawMethod}.` } });

    const phone = customer.phone ? normalizePhone(customer.phone) : null;
    if (rawMethod === 'mb_way' && !phone) return res.status(400).json({ error: { message: "Telefone inválido para MB WAY." } });

    if (transaction) {
        transaction = await prisma.transaction.update({ where: { id: transaction.id }, data: { status: 'pending', gatewayVaultId: gatewayVault.id } });
    } else {
        transaction = await prisma.transaction.create({
            data: { 
              merchantId: store.merchantId, 
              storeId: store.id, 
              gatewayVaultId: gatewayVault.id, 
              reference: merchantReference, 
              amount: amount / 100, // <--- CONVERSÃO PARA EUROS NA BD
              currency, 
              status: 'pending', 
              method: rawMethod, 
              gateway: gatewayVault.provider, 
              rawRequest: JSON.parse(JSON.stringify(req.body)), 
              customerEmail: customer.email || null 
            }
        });
    }

    if (gatewayVault.provider.toLowerCase().startsWith('stripe')) {
      const credentials = gatewayVault.credentials as any;
      const stripeClient = new Stripe(credentials.secretKey, { apiVersion: '2026-06-24.dahlia' as any });

      // Enviamos o amount original (em cêntimos) para a Stripe
      const stripePayload: any = { amount, currency: currency.toLowerCase(), payment_method_types: [rawMethod], metadata: { nexflowx_transaction_id: transaction.id } };
      const billing = { phone: phone || undefined, email: customer.email || undefined, name: customer.name || undefined };

      if (rawMethod === 'mb_way') {
        stripePayload.payment_method_data = { type: 'mb_way', billing_details: billing };
        stripePayload.confirm = true;
      } else if (rawMethod === 'multibanco') {
        stripePayload.payment_method_data = { type: 'multibanco', billing_details: billing };
        stripePayload.confirm = true;
      } else if (rawMethod === 'bizum') {
        stripePayload.payment_method_data = { type: 'bizum', billing_details: billing };
        stripePayload.confirm = true;
        stripePayload.return_url = metadata.return_url || 'https://xpayments.digital/callback';
      }

      const paymentIntent = await stripeClient.paymentIntents.create(stripePayload);
      await prisma.transaction.update({ where: { id: transaction.id }, data: { providerId: paymentIntent.id, rawResponse: JSON.parse(JSON.stringify(paymentIntent)) } });

      let orchestratorAction: any = null;
      if (paymentIntent.status === 'requires_action') {
        const nextAction = paymentIntent.next_action as any;

        if (rawMethod === 'multibanco' && nextAction?.multibanco_display_details) {
          orchestratorAction = {
            entidade: nextAction.multibanco_display_details.entity,
            referencia: nextAction.multibanco_display_details.reference,
            montante: (amount / 100).toFixed(2) + " " + currency.toUpperCase()
          };
        } else if (rawMethod === 'mb_way') {
          orchestratorAction = { message: 'Push enviado. Confirme na App.' };
        } else if (nextAction?.redirect_to_url || nextAction?.bizum_authorize_url) {
          orchestratorAction = { url: nextAction.redirect_to_url?.url || nextAction.bizum_authorize_url };
        }
      }

      return res.status(200).json({ success: true, status: paymentIntent.status, method: rawMethod, action: orchestratorAction });
    }
    return res.status(400).json({ error: { message: "Provedor não suportado." } });
  } catch (error: any) { return res.status(500).json({ error: { message: error.message } }); }
};
