import { Response } from 'express';
import crypto from 'node:crypto';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const WORKFLOW = [
  ['CONTRACT_PAYMENT', 'Contratação e Pagamento'],
  ['INFORMATION_COLLECTION', 'Recolha de Informações'],
  ['KYC_KYB', 'KYC / KYB'],
  ['ENTITY_FORMATION', 'Criação da Estrutura Empresarial'],
  ['BANKING_ONBOARDING', 'Onboarding Bancário'],
  ['ACQUIRER_ONBOARDING', 'Onboarding Adquirentes'],
  ['DOMAIN_SETUP', 'Domínio'],
  ['EMAIL_SETUP', 'Email Empresarial'],
  ['PHONE_SETUP', 'Número de Celular'],
  ['WEBSITE_SETUP', 'Website'],
  ['VPS_API_SETUP', 'VPS / API'],
  ['XPAYMENTS_STORE_SETUP', 'Store XPAYMENTS'],
  ['QUALITY_CHECK', 'Quality Check'],
  ['DELIVERY', 'Entrega']
] as const;

const merchantIdFrom = (req: AuthRequest) =>
  String(req.merchantId || req.user?.id || '').trim();

const orderCode = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `EXP-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

export const listMerchantOrders = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdFrom(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }

    const orders = await prisma.$queryRaw<any[]>`
      select
        so.id,
        so.order_code,
        so.status,
        so.progress,
        so.payment_status,
        so.payment_currency,
        so.payment_amount,
        so.transaction_id,
        so.checkout_session_id,
        so.target_store_id,
        so.assigned_to,
        so.customer_notes,
        so.created_at,
        so.updated_at,
        off.code as offering_code,
        off.slug as offering_slug,
        off.name as offering_name,
        off.jurisdiction,
        off.prices,
        off.management_fee_percent,
        off.lead_time_text
      from service_orders so
      join service_offerings off on off.id = so.offering_id
      where so.merchant_id = cast(${merchantId} as uuid)
      order by so.created_at desc
    `;

    const steps = await prisma.$queryRaw<any[]>`
      select
        s.service_order_id,
        s.id,
        s.code,
        s.label,
        s.status,
        s.position,
        s.started_at,
        s.completed_at,
        s.notes
      from service_order_steps s
      join service_orders so on so.id = s.service_order_id
      where so.merchant_id = cast(${merchantId} as uuid)
      order by s.service_order_id, s.position
    `;

    const stepsByOrder = new Map<string, any[]>();
    for (const step of steps) {
      const key = String(step.service_order_id);
      const bucket = stepsByOrder.get(key) || [];
      bucket.push({
        id: step.id,
        code: step.code,
        label: step.label,
        status: step.status,
        position: step.position,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        notes: step.notes
      });
      stepsByOrder.set(key, bucket);
    }

    return res.json({
      success: true,
      data: {
        orders: orders.map(order => ({
          id: order.id,
          orderCode: order.order_code,
          status: order.status,
          progress: order.progress,
          paymentStatus: order.payment_status,
          paymentCurrency: order.payment_currency,
          paymentAmount: order.payment_amount == null ? null : Number(order.payment_amount),
          transactionId: order.transaction_id,
          checkoutSessionId: order.checkout_session_id,
          targetStoreId: order.target_store_id,
          assignedTo: order.assigned_to,
          customerNotes: order.customer_notes,
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          offering: {
            code: order.offering_code,
            slug: order.offering_slug,
            name: order.offering_name,
            jurisdiction: order.jurisdiction,
            prices: order.prices,
            managementFeePercent: Number(order.management_fee_percent || 0),
            leadTime: order.lead_time_text
          },
          steps: stepsByOrder.get(String(order.id)) || []
        }))
      }
    });
  } catch (error: any) {
    console.error('[expert.orders.list]', { code: error?.code || null, message: error?.message || 'unknown' });
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Não foi possível carregar as contratações.' } });
  }
};

export const createMerchantOrder = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdFrom(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }

    const offeringCode = String(req.body?.offeringCode || '').trim().toUpperCase();
    const currency = String(req.body?.currency || 'EUR').trim().toUpperCase();
    const customerNotes = String(req.body?.notes || '').trim().slice(0, 4000) || null;

    if (!offeringCode || !['EUR', 'BRL', 'USDT'].includes(currency)) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Serviço ou moeda inválidos.' } });
    }

    const offeringRows = await prisma.$queryRaw<any[]>`
      select id, code, slug, name, prices, availability_limit, active
      from service_offerings
      where code = ${offeringCode}
      limit 1
    `;
    const offering = offeringRows[0];

    if (!offering || offering.active !== true) {
      return res.status(404).json({ success: false, error: { code: 'OFFERING_NOT_AVAILABLE', message: 'Serviço indisponível.' } });
    }

    const prices = offering.prices || {};
    const amount = Number(prices[currency]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: { code: 'CURRENCY_NOT_AVAILABLE', message: 'Moeda não disponível para este serviço.' } });
    }

    if (Number.isInteger(offering.availability_limit) && offering.availability_limit > 0) {
      const countRows = await prisma.$queryRaw<any[]>`
        select count(*)::int as count
        from service_orders
        where offering_id = cast(${offering.id} as uuid)
          and status <> 'CANCELLED'
      `;
      if (Number(countRows[0]?.count || 0) >= Number(offering.availability_limit)) {
        return res.status(409).json({ success: false, error: { code: 'OFFERING_SOLD_OUT', message: 'A disponibilidade atual deste serviço foi atingida.' } });
      }
    }

    const code = orderCode();

    const created = await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<any[]>`
        insert into service_orders (
          order_code, merchant_id, offering_id, status, progress,
          payment_status, payment_currency, payment_amount, customer_notes
        ) values (
          ${code}, cast(${merchantId} as uuid), cast(${offering.id} as uuid),
          'ORDER_CREATED', 5, 'PENDING', ${currency}, ${amount}, ${customerNotes}
        )
        returning id, order_code, status, progress, payment_status, payment_currency, payment_amount, created_at
      `;
      const order = rows[0];

      for (let index = 0; index < WORKFLOW.length; index += 1) {
        const [stepCode, label] = WORKFLOW[index];
        await tx.$executeRaw`
          insert into service_order_steps (
            service_order_id, code, label, status, position, started_at
          ) values (
            cast(${order.id} as uuid), ${stepCode}, ${label},
            ${index === 0 ? 'IN_PROGRESS' : 'PENDING'}, ${index + 1},
            ${index === 0 ? new Date() : null}
          )
        `;
      }

      return order;
    });

    return res.status(201).json({
      success: true,
      data: {
        order: {
          id: created.id,
          orderCode: created.order_code,
          status: created.status,
          progress: created.progress,
          paymentStatus: created.payment_status,
          paymentCurrency: created.payment_currency,
          paymentAmount: Number(created.payment_amount),
          createdAt: created.created_at,
          offering: { code: offering.code, slug: offering.slug, name: offering.name }
        }
      }
    });
  } catch (error: any) {
    console.error('[expert.orders.create]', { code: error?.code || null, message: error?.message || 'unknown' });
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Não foi possível iniciar a contratação.' } });
  }
};
