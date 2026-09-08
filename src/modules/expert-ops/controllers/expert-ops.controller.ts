import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const STEP_STATUSES = new Set(['PENDING','IN_PROGRESS','COMPLETED','BLOCKED','SKIPPED']);
const ASSET_KINDS = new Set([
  'LEGAL_ENTITY','COMPANY_NUMBER','BANK_ACCOUNT','ACQUIRER','DOMAIN','EMAIL','PHONE','VPS','WEBSITE','XPAYMENTS_STORE','GATEWAY_VAULT','PROVIDER_CONNECTION','DOCUMENT','OTHER'
]);

const actorId = (req: AuthRequest) => String(req.merchantId || req.user?.id || '').trim();

async function requirePermission(req: AuthRequest, permission: string) {
  const actor = actorId(req);
  if (!actor) return null;

  const rows = await prisma.$queryRaw<any[]>`
    select id, merchant_id, role, permissions, active
    from expert_ops_members
    where merchant_id = cast(${actor} as uuid)
      and active = true
    limit 1
  `;

  const member = rows[0];
  if (!member) return null;
  const permissions = Array.isArray(member.permissions) ? member.permissions : [];
  if (member.role !== 'admin' && !permissions.includes(permission)) return null;
  return member;
}

async function audit(
  actorMerchantId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  beforeData: any,
  afterData: any,
  metadata: any = {}
) {
  await prisma.$executeRaw`
    insert into expert_ops_audit_logs (
      actor_merchant_id, action, entity_type, entity_id,
      before_data, after_data, metadata
    ) values (
      cast(${actorMerchantId} as uuid), ${action}, ${entityType},
      ${entityId ? entityId : null}::uuid,
      ${JSON.stringify(beforeData ?? null)}::jsonb,
      ${JSON.stringify(afterData ?? null)}::jsonb,
      ${JSON.stringify(metadata ?? {})}::jsonb
    )
  `;
}

async function recalcOrder(orderId: string) {
  const rows = await prisma.$queryRaw<any[]>`
    select code, status, position
    from service_order_steps
    where service_order_id = cast(${orderId} as uuid)
    order by position
  `;

  const total = rows.length || 1;
  const completed = rows.filter(row => ['COMPLETED','SKIPPED'].includes(String(row.status))).length;
  const active = rows.find(row => String(row.status) === 'IN_PROGRESS');
  const currentPosition = active ? Number(active.position) : completed;
  const progress = completed === total ? 100 : Math.max(5, Math.min(99, Math.round((Math.max(completed, currentPosition) / total) * 100)));
  const status = completed === total ? 'DELIVERED' : (active?.code || 'IN_PROGRESS');

  await prisma.$executeRaw`
    update service_orders
    set progress = ${progress},
        status = ${status},
        updated_at = now()
    where id = cast(${orderId} as uuid)
  `;

  return { progress, status };
}

export const getOpsProfile = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_orders_read');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Acesso Expert Operations não autorizado.' } });

    return res.json({ success:true, data:{ member:{ merchantId:member.merchant_id, role:member.role, permissions:member.permissions || [] } } });
  } catch (error:any) {
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível validar o acesso interno.' } });
  }
};

export const listOpsOrders = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_orders_read');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Sem permissão para consultar operações.' } });

    const status = String(req.query.status || '').trim().toUpperCase();
    const paymentStatus = String(req.query.paymentStatus || '').trim().toUpperCase();
    const search = String(req.query.search || '').trim();

    const rows = await prisma.$queryRawUnsafe<any[]>(`
      select
        so.id, so.order_code, so.status, so.progress, so.payment_status,
        so.payment_currency, so.payment_amount, so.assigned_to,
        so.created_at, so.updated_at,
        m.id as merchant_id, m.name as merchant_name, m.email as merchant_email,
        off.code as offering_code, off.name as offering_name, off.jurisdiction,
        (
          select s.code from service_order_steps s
          where s.service_order_id = so.id and s.status = 'IN_PROGRESS'
          order by s.position limit 1
        ) as current_step
      from service_orders so
      join merchants m on m.id = so.merchant_id
      join service_offerings off on off.id = so.offering_id
      where ($1 = '' or so.status = $1)
        and ($2 = '' or so.payment_status = $2)
        and ($3 = '' or so.order_code ilike '%'||$3||'%' or m.name ilike '%'||$3||'%' or m.email ilike '%'||$3||'%')
      order by so.created_at desc
      limit 300
    `, status, paymentStatus, search);

    return res.json({ success:true, data:{ orders:rows.map(row => ({
      id:row.id, orderCode:row.order_code, status:row.status, progress:Number(row.progress||0),
      paymentStatus:row.payment_status, paymentCurrency:row.payment_currency,
      paymentAmount:row.payment_amount == null ? null : Number(row.payment_amount),
      assignedTo:row.assigned_to, currentStep:row.current_step,
      createdAt:row.created_at, updatedAt:row.updated_at,
      merchant:{ id:row.merchant_id, name:row.merchant_name, email:row.merchant_email },
      offering:{ code:row.offering_code, name:row.offering_name, jurisdiction:row.jurisdiction }
    })) } });
  } catch (error:any) {
    console.error('[expert-ops.orders.list]', error?.message || error);
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível carregar as operações.' } });
  }
};

export const getOpsOrder = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_orders_read');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Sem permissão para consultar operações.' } });
    const orderId = String(req.params.orderId || '').trim();

    const orders = await prisma.$queryRaw<any[]>`
      select so.*, m.name as merchant_name, m.email as merchant_email,
             off.code as offering_code, off.name as offering_name, off.jurisdiction, off.lead_time_text
      from service_orders so
      join merchants m on m.id = so.merchant_id
      join service_offerings off on off.id = so.offering_id
      where so.id = cast(${orderId} as uuid)
      limit 1
    `;
    if (!orders[0]) return res.status(404).json({ success:false, error:{ code:'NOT_FOUND', message:'Operação não encontrada.' } });

    const steps = await prisma.$queryRaw<any[]>`
      select id, code, label, status, position, started_at, completed_at, notes, metadata
      from service_order_steps
      where service_order_id = cast(${orderId} as uuid)
      order by position
    `;
    const assets = await prisma.$queryRaw<any[]>`
      select id, kind, label, value_text, url, sensitive, metadata, created_at, updated_at
      from service_order_assets
      where service_order_id = cast(${orderId} as uuid)
      order by created_at
    `;
    const audits = await prisma.$queryRaw<any[]>`
      select id, action, actor_merchant_id, metadata, created_at
      from expert_ops_audit_logs
      where entity_id = cast(${orderId} as uuid)
      order by created_at desc
      limit 100
    `;

    const order = orders[0];
    return res.json({ success:true, data:{
      order:{
        id:order.id, orderCode:order.order_code, status:order.status, progress:Number(order.progress||0),
        paymentStatus:order.payment_status, paymentCurrency:order.payment_currency,
        paymentAmount:order.payment_amount == null ? null : Number(order.payment_amount),
        assignedTo:order.assigned_to, internalNotes:order.internal_notes, customerNotes:order.customer_notes,
        transactionId:order.transaction_id, checkoutSessionId:order.checkout_session_id, targetStoreId:order.target_store_id,
        metadata:order.metadata || {}, createdAt:order.created_at, updatedAt:order.updated_at,
        merchant:{ id:order.merchant_id, name:order.merchant_name, email:order.merchant_email },
        offering:{ id:order.offering_id, code:order.offering_code, name:order.offering_name, jurisdiction:order.jurisdiction, leadTime:order.lead_time_text }
      },
      steps:steps.map(s => ({ id:s.id, code:s.code, label:s.label, status:s.status, position:s.position, startedAt:s.started_at, completedAt:s.completed_at, notes:s.notes, metadata:s.metadata || {} })),
      assets:assets.map(a => ({ id:a.id, kind:a.kind, label:a.label, valueText:a.value_text, url:a.url, sensitive:a.sensitive, metadata:a.metadata || {}, createdAt:a.created_at, updatedAt:a.updated_at })),
      audit:audits.map(a => ({ id:a.id, action:a.action, actorMerchantId:a.actor_merchant_id, metadata:a.metadata || {}, createdAt:a.created_at }))
    } });
  } catch (error:any) {
    console.error('[expert-ops.order.get]', error?.message || error);
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível carregar a operação.' } });
  }
};

export const confirmOpsPayment = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_payment_confirm');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Sem permissão para confirmar pagamentos.' } });
    const orderId = String(req.params.orderId || '').trim();
    const proofReference = String(req.body?.proofReference || '').trim().slice(0, 300) || null;
    const note = String(req.body?.note || '').trim().slice(0, 2000) || null;

    const result = await prisma.$transaction(async tx => {
      const beforeRows = await tx.$queryRaw<any[]>`
        select id, payment_status, status, progress, metadata
        from service_orders where id = cast(${orderId} as uuid) for update
      `;
      const before = beforeRows[0];
      if (!before) throw new Error('ORDER_NOT_FOUND');
      if (before.payment_status === 'PAID') return { alreadyPaid:true, before, after:before };

      const metadata = { ...(before.metadata || {}), manualPaymentConfirmation:{ confirmedAt:new Date().toISOString(), confirmedBy:member.merchant_id, proofReference, note } };
      await tx.$executeRaw`
        update service_orders
        set payment_status='PAID', metadata=${JSON.stringify(metadata)}::jsonb, updated_at=now()
        where id = cast(${orderId} as uuid)
      `;
      await tx.$executeRaw`
        update service_order_steps
        set status='COMPLETED', completed_at=coalesce(completed_at, now()), started_at=coalesce(started_at, now()), notes=coalesce(${note}, notes), updated_at=now()
        where service_order_id = cast(${orderId} as uuid) and code='CONTRACT_PAYMENT'
      `;
      await tx.$executeRaw`
        update service_order_steps
        set status='IN_PROGRESS', started_at=coalesce(started_at, now()), updated_at=now()
        where service_order_id = cast(${orderId} as uuid) and code='INFORMATION_COLLECTION' and status='PENDING'
      `;
      const afterRows = await tx.$queryRaw<any[]>`select id, payment_status, status, progress, metadata from service_orders where id=cast(${orderId} as uuid)`;
      return { alreadyPaid:false, before, after:afterRows[0] };
    });

    if (!result.alreadyPaid) {
      const calc = await recalcOrder(orderId);
      await audit(String(member.merchant_id), 'PAYMENT_CONFIRMED_MANUAL', 'service_order', orderId, result.before, { ...result.after, ...calc }, { proofReference, note, financialMutation:false });
    }

    return res.json({ success:true, data:{ orderId, paymentStatus:'PAID', alreadyPaid:result.alreadyPaid, financialMutation:false } });
  } catch (error:any) {
    if (error?.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success:false, error:{ code:'NOT_FOUND', message:'Operação não encontrada.' } });
    console.error('[expert-ops.payment.confirm]', error?.message || error);
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível confirmar o pagamento.' } });
  }
};

export const updateOpsStep = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_orders_write');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Sem permissão para atualizar processos.' } });
    const orderId = String(req.params.orderId || '').trim();
    const stepCode = String(req.params.stepCode || '').trim().toUpperCase();
    const status = String(req.body?.status || '').trim().toUpperCase();
    const notes = String(req.body?.notes || '').trim().slice(0, 4000) || null;
    if (!STEP_STATUSES.has(status)) return res.status(400).json({ success:false, error:{ code:'BAD_REQUEST', message:'Estado da etapa inválido.' } });

    const beforeRows = await prisma.$queryRaw<any[]>`
      select id, code, status, notes, started_at, completed_at
      from service_order_steps
      where service_order_id=cast(${orderId} as uuid) and code=${stepCode}
      limit 1
    `;
    const before = beforeRows[0];
    if (!before) return res.status(404).json({ success:false, error:{ code:'NOT_FOUND', message:'Etapa não encontrada.' } });

    await prisma.$executeRaw`
      update service_order_steps
      set status=${status},
          notes=coalesce(${notes}, notes),
          started_at=case when ${status}='IN_PROGRESS' then coalesce(started_at, now()) else started_at end,
          completed_at=case when ${status} in ('COMPLETED','SKIPPED') then coalesce(completed_at, now()) else null end,
          updated_at=now()
      where id=cast(${before.id} as uuid)
    `;
    const afterRows = await prisma.$queryRaw<any[]>`select id, code, status, notes, started_at, completed_at from service_order_steps where id=cast(${before.id} as uuid)`;
    const calc = await recalcOrder(orderId);
    await audit(String(member.merchant_id), 'STEP_UPDATED', 'service_order', orderId, before, afterRows[0], { stepCode, ...calc });

    return res.json({ success:true, data:{ step:afterRows[0], order:calc } });
  } catch (error:any) {
    console.error('[expert-ops.step.update]', error?.message || error);
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível atualizar a etapa.' } });
  }
};

export const updateOpsOrder = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_orders_write');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Sem permissão para atualizar operações.' } });
    const orderId = String(req.params.orderId || '').trim();
    const assignedTo = req.body?.assignedTo == null ? undefined : String(req.body.assignedTo).trim().slice(0,200) || null;
    const internalNotes = req.body?.internalNotes == null ? undefined : String(req.body.internalNotes).trim().slice(0,8000) || null;

    const beforeRows = await prisma.$queryRaw<any[]>`select id, assigned_to, internal_notes from service_orders where id=cast(${orderId} as uuid)`;
    if (!beforeRows[0]) return res.status(404).json({ success:false, error:{ code:'NOT_FOUND', message:'Operação não encontrada.' } });

    await prisma.$executeRawUnsafe(
      `update service_orders set assigned_to=case when $2::boolean then $3 else assigned_to end, internal_notes=case when $4::boolean then $5 else internal_notes end, updated_at=now() where id=$1::uuid`,
      orderId, assignedTo !== undefined, assignedTo ?? null, internalNotes !== undefined, internalNotes ?? null
    );
    const afterRows = await prisma.$queryRaw<any[]>`select id, assigned_to, internal_notes from service_orders where id=cast(${orderId} as uuid)`;
    await audit(String(member.merchant_id), 'ORDER_UPDATED', 'service_order', orderId, beforeRows[0], afterRows[0]);
    return res.json({ success:true, data:{ order:afterRows[0] } });
  } catch (error:any) {
    console.error('[expert-ops.order.update]', error?.message || error);
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível atualizar a operação.' } });
  }
};

export const createOpsAsset = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_assets_write');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Sem permissão para gerir entregáveis.' } });
    const orderId = String(req.params.orderId || '').trim();
    const kind = String(req.body?.kind || '').trim().toUpperCase();
    const label = String(req.body?.label || '').trim().slice(0,300) || null;
    const valueText = String(req.body?.valueText || '').trim().slice(0,4000) || null;
    const url = String(req.body?.url || '').trim().slice(0,2000) || null;
    const sensitive = Boolean(req.body?.sensitive);
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    if (!ASSET_KINDS.has(kind)) return res.status(400).json({ success:false, error:{ code:'BAD_REQUEST', message:'Tipo de asset inválido.' } });
    if (!valueText && !url) return res.status(400).json({ success:false, error:{ code:'BAD_REQUEST', message:'Asset sem valor ou URL.' } });

    const order = await prisma.$queryRaw<any[]>`select id from service_orders where id=cast(${orderId} as uuid)`;
    if (!order[0]) return res.status(404).json({ success:false, error:{ code:'NOT_FOUND', message:'Operação não encontrada.' } });

    const rows = await prisma.$queryRaw<any[]>`
      insert into service_order_assets (service_order_id, kind, label, value_text, url, sensitive, metadata)
      values (cast(${orderId} as uuid), ${kind}, ${label}, ${valueText}, ${url}, ${sensitive}, ${JSON.stringify(metadata)}::jsonb)
      returning id, kind, label, value_text, url, sensitive, metadata, created_at
    `;
    await audit(String(member.merchant_id), 'ASSET_CREATED', 'service_order', orderId, null, rows[0], { assetId:rows[0].id, kind, sensitive });
    return res.status(201).json({ success:true, data:{ asset:rows[0] } });
  } catch (error:any) {
    console.error('[expert-ops.asset.create]', error?.message || error);
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível adicionar o entregável.' } });
  }
};

export const listOpsAudit = async (req: AuthRequest, res: Response) => {
  try {
    const member = await requirePermission(req, 'expert_audit_read');
    if (!member) return res.status(403).json({ success:false, error:{ code:'FORBIDDEN', message:'Sem permissão para consultar auditoria.' } });
    const orderId = String(req.query.orderId || '').trim();
    const rows = orderId
      ? await prisma.$queryRaw<any[]>`select * from expert_ops_audit_logs where entity_id=cast(${orderId} as uuid) order by created_at desc limit 300`
      : await prisma.$queryRaw<any[]>`select * from expert_ops_audit_logs order by created_at desc limit 300`;
    return res.json({ success:true, data:{ audit:rows } });
  } catch (error:any) {
    return res.status(500).json({ success:false, error:{ code:'SERVER_ERROR', message:'Não foi possível carregar auditoria.' } });
  }
};
