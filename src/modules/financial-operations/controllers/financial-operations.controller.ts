import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

type Row = Record<string, any>;
const CURRENCY = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const FINANCE_TIMEZONE = 'Europe/Lisbon';

const centerInput = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  storeId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
});

const costInput = z.object({
  costCenterId: z.string().uuid(),
  storeId: z.string().uuid().optional().nullable(),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().min(2).max(500),
  amount: z.coerce.number().positive().max(999999999999),
  currency: CURRENCY.default('EUR'),
  competenceDate: DATE,
  dueDate: DATE.optional().nullable(),
  paidOn: DATE.optional().nullable(),
  status: z.enum(['draft', 'submitted', 'approved', 'reserved', 'paid']).default('draft'),
  source: z.enum(['manual', 'import', 'api', 'integration', 'system']).default('manual'),
  supplierName: z.string().trim().max(160).optional().nullable(),
  externalReference: z.string().trim().max(160).optional().nullable(),
  idempotencyKey: z.string().trim().max(180).optional().nullable(),
  reportingCurrency: CURRENCY.optional().nullable(),
});

const statusInput = z.object({
  status: z.enum(['draft', 'submitted', 'approved', 'reserved', 'paid', 'cancelled']),
  paidOn: DATE.optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

const merchantId = (req: AuthRequest) => req.merchantId || req.user?.id || null;
const actor = (req: AuthRequest) => String(req.user?.id || req.merchantId || 'authenticated-user');
const number = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
};
const count = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const isoDate = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null;
const currency = (req: AuthRequest, key = 'currency', fallback = 'EUR') => {
  const parsed = CURRENCY.safeParse(req.query[key] || fallback);
  return parsed.success ? parsed.data : fallback;
};
const dateFilter = (req: AuthRequest) => ({
  from: typeof req.query.from === 'string' && DATE.safeParse(req.query.from).success ? req.query.from : null,
  to: typeof req.query.to === 'string' && DATE.safeParse(req.query.to).success ? req.query.to : null,
});
const bad = (res: Response, message: string, status = 400, details?: unknown) =>
  res.status(status).json({ success: false, message, ...(details ? { error: { details } } : {}) });
const internal = (res: Response, error: unknown, message: string) => {
  console.error(`[FINANCIAL_OPERATIONS] ${message}`, error);
  return bad(res, message, 500);
};

const latestFx = async (base: string, quote: string) => {
  if (base === quote) return { id: null, baseCurrency: base, quoteCurrency: quote, rate: 1, rateDate: new Date().toISOString().slice(0, 10), source: 'IDENTITY', rateType: 'indicative' };
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT * FROM public.finance_fx_rates
    WHERE base_currency = ${base} AND quote_currency = ${quote}
    ORDER BY rate_date DESC, created_at DESC LIMIT 1
  `);
  const row = rows[0];
  return row ? { id: row.id, baseCurrency: row.base_currency, quoteCurrency: row.quote_currency, rate: Number(row.rate), rateDate: isoDate(row.rate_date), source: row.source, rateType: row.rate_type, sourceTimestamp: row.source_timestamp } : null;
};

export const getFinancialOperationsOverview = async (req: AuthRequest, res: Response) => {
  const merchant = merchantId(req);
  if (!merchant) return bad(res, 'Merchant não autenticado.', 401);
  const base = currency(req);
  const quote = currency(req, 'reportingCurrency', 'BRL');
  const { from, to } = dateFilter(req);
  try {
    const [walletRows, payoutRows, costRows, planRows, releaseRows, fx] = await Promise.all([
      prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT id, balance, available, reserved, COALESCE(reconciliation_hold, 0) reconciliation_hold
        FROM public.wallets WHERE merchant_id = ${merchant}::uuid AND upper(currency) = ${base} LIMIT 1
      `),
      prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status='paid'),0) paid,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('scheduled','processing')),0) scheduled,
          COUNT(*) FILTER (WHERE status='paid') paid_count,
          COUNT(*) FILTER (WHERE status IN ('scheduled','processing')) scheduled_count
        FROM public.payout_statements
        WHERE merchant_id=${merchant}::uuid AND upper(currency)=${base}
          AND (${from}::date IS NULL OR COALESCE(paid_on,scheduled_for,created_at::date)>=${from}::date)
          AND (${to}::date IS NULL OR COALESCE(paid_on,scheduled_for,created_at::date)<=${to}::date)
      `),
      prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status IN ('approved','reserved')),0) committed,
          COALESCE(SUM(amount) FILTER (WHERE status='paid'),0) paid,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('draft','submitted')),0) pending_approval,
          COUNT(*) FILTER (WHERE status IN ('approved','reserved')) committed_count,
          COUNT(*) FILTER (WHERE status='paid') paid_count
        FROM public.finance_cost_entries
        WHERE merchant_id=${merchant}::uuid AND upper(currency)=${base}
          AND (${from}::date IS NULL OR competence_date>=${from}::date)
          AND (${to}::date IS NULL OR competence_date<=${to}::date)
      `),
      prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(source_total) FILTER (WHERE status<>'cancelled'),0) source_total,
          COALESCE(SUM(cost_total) FILTER (WHERE status<>'cancelled'),0) cost_total,
          COALESCE(SUM(distributable_total) FILTER (WHERE status<>'cancelled'),0) distributable_total,
          COALESCE(SUM(allocated_total) FILTER (WHERE status<>'cancelled'),0) allocated_total,
          COUNT(*) FILTER (WHERE status IN ('draft','calculated','approved','partially_paid')) open_count
        FROM public.finance_distribution_plans
        WHERE merchant_id=${merchant}::uuid AND upper(currency)=${base}
          AND (${from}::date IS NULL OR period_end>=${from}::date)
          AND (${to}::date IS NULL OR period_start<=${to}::date)
      `),
      prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT COALESCE(SUM(amount),0) forecast_amount,
          MIN(COALESCE(manual_estimated_release_on,provider_available_on,system_estimated_release_on,expected_release_at::date)) next_release_date,
          COUNT(*) movement_count
        FROM public.wallet_movements
        WHERE merchant_id=${merchant}::uuid AND upper(currency)=${base}
          AND direction='in' AND type='payment' AND status='pendente'
      `),
      latestFx(base, quote),
    ]);
    const wallet = walletRows[0] || {}, payouts = payoutRows[0] || {}, costs = costRows[0] || {}, plans = planRows[0] || {}, releases = releaseRows[0] || {};
    const available = number(wallet.available), committedCosts = number(costs.committed), scheduledPayouts = number(payouts.scheduled);
    const freeCash = Math.max(0, number(available - committedCosts - scheduledPayouts));
    const convert = (value: number) => fx ? number(value * fx.rate) : null;
    return res.json({ success: true, data: {
      currency: base, reportingCurrency: quote, timezone: FINANCE_TIMEZONE, period: { from, to }, fx,
      wallet: { id: wallet.id || null, balance: number(wallet.balance), available, reserved: number(wallet.reserved), reconciliationHold: number(wallet.reconciliation_hold), totalRestricted: number(number(wallet.reserved)+number(wallet.reconciliation_hold)) },
      releases: { forecastAmount: number(releases.forecast_amount), nextReleaseDate: isoDate(releases.next_release_date), movementCount: count(releases.movement_count) },
      payouts: { paid: number(payouts.paid), paidCount: count(payouts.paid_count), scheduled: scheduledPayouts, scheduledCount: count(payouts.scheduled_count) },
      costs: { committed: committedCosts, committedCount: count(costs.committed_count), paid: number(costs.paid), paidCount: count(costs.paid_count), pendingApproval: number(costs.pending_approval) },
      distributions: { sourceTotal: number(plans.source_total), costTotal: number(plans.cost_total), distributableTotal: number(plans.distributable_total), allocatedTotal: number(plans.allocated_total), openCount: count(plans.open_count) },
      cashflow: { available, committedCosts, scheduledPayouts, freeCash, reporting: { currency: quote, available: convert(available), committedCosts: convert(committedCosts), scheduledPayouts: convert(scheduledPayouts), freeCash: convert(freeCash) } },
      generatedAt: new Date().toISOString(),
    }});
  } catch (error) { return internal(res, error, 'Erro ao carregar a operação financeira.'); }
};

export const listCostCenters = async (req: AuthRequest, res: Response) => {
  const merchant = merchantId(req); if (!merchant) return bad(res, 'Merchant não autenticado.', 401);
  try {
    const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT c.id,c.code,c.name,c.description,c.status,c.store_id,c.parent_id,s.store_code,s.name store_name,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status<>'cancelled'),0) total_amount,
        COUNT(e.id) FILTER (WHERE e.status<>'cancelled') entry_count,c.created_at,c.updated_at
      FROM public.finance_cost_centers c
      LEFT JOIN public.stores s ON s.id=c.store_id
      LEFT JOIN public.finance_cost_entries e ON e.cost_center_id=c.id
      WHERE c.merchant_id=${merchant}::uuid GROUP BY c.id,s.store_code,s.name ORDER BY c.status,c.name
    `);
    return res.json({ success: true, data: rows.map(r => ({ id:r.id,code:r.code,name:r.name,description:r.description,status:r.status,storeId:r.store_id,storeCode:r.store_code,storeName:r.store_name,parentId:r.parent_id,totalAmount:number(r.total_amount),entryCount:count(r.entry_count),createdAt:r.created_at,updatedAt:r.updated_at })) });
  } catch (error) { return internal(res,error,'Erro ao carregar centros de custo.'); }
};

export const createCostCenter = async (req: AuthRequest, res: Response) => {
  const merchant = merchantId(req); if (!merchant) return bad(res,'Merchant não autenticado.',401);
  const parsed = centerInput.safeParse(req.body); if (!parsed.success) return bad(res,'Dados do centro de custo inválidos.',400,parsed.error.flatten());
  const data=parsed.data, code=data.code.toUpperCase().replace(/[^A-Z0-9_-]+/g,'-');
  try {
    const rows=await prisma.$queryRaw<Row[]>(Prisma.sql`
      INSERT INTO public.finance_cost_centers (merchant_id,store_id,parent_id,code,name,description,created_by)
      VALUES (${merchant}::uuid,${data.storeId||null}::uuid,${data.parentId||null}::uuid,${code},${data.name},${data.description||null},${actor(req)}) RETURNING *
    `);
    return res.status(201).json({success:true,data:rows[0]});
  } catch(error){return internal(res,error,'Erro ao criar centro de custo.');}
};

const mapCost=(r:Row)=>({id:r.id,costCenterId:r.cost_center_id,costCenterCode:r.cost_center_code,costCenterName:r.cost_center_name,storeId:r.store_id,storeCode:r.store_code,storeName:r.store_name,category:r.category,description:r.description,amount:number(r.amount),currency:r.currency,competenceDate:isoDate(r.competence_date),dueDate:isoDate(r.due_date),paidOn:isoDate(r.paid_on),status:r.status,source:r.source,supplierName:r.supplier_name,externalReference:r.external_reference,reportingCurrency:r.reporting_currency,reportingRate:r.reporting_rate?Number(r.reporting_rate):null,reportingAmount:r.reporting_amount?number(r.reporting_amount):null,metadata:r.metadata,createdAt:r.created_at,updatedAt:r.updated_at});

export const listCostEntries=async(req:AuthRequest,res:Response)=>{
  const merchant=merchantId(req); if(!merchant)return bad(res,'Merchant não autenticado.',401);
  const base=currency(req),{from,to}=dateFilter(req),status=typeof req.query.status==='string'?req.query.status:null;
  try{const rows=await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT e.*,c.code cost_center_code,c.name cost_center_name,s.store_code,s.name store_name
    FROM public.finance_cost_entries e JOIN public.finance_cost_centers c ON c.id=e.cost_center_id LEFT JOIN public.stores s ON s.id=e.store_id
    WHERE e.merchant_id=${merchant}::uuid AND upper(e.currency)=${base}
      AND (${from}::date IS NULL OR e.competence_date>=${from}::date) AND (${to}::date IS NULL OR e.competence_date<=${to}::date)
      AND (${status}::text IS NULL OR e.status=${status}::text) ORDER BY e.competence_date DESC,e.created_at DESC LIMIT 500
  `);return res.json({success:true,data:rows.map(mapCost)});}catch(error){return internal(res,error,'Erro ao carregar custos e compromissos.');}
};

export const createCostEntry=async(req:AuthRequest,res:Response)=>{
  const merchant=merchantId(req);if(!merchant)return bad(res,'Merchant não autenticado.',401);
  const parsed=costInput.safeParse(req.body);if(!parsed.success)return bad(res,'Dados do custo inválidos.',400,parsed.error.flatten());
  const d=parsed.data,a=actor(req);
  try{const result=await prisma.$transaction(async tx=>{
    const center=await tx.$queryRaw<Row[]>(Prisma.sql`SELECT id FROM public.finance_cost_centers WHERE id=${d.costCenterId}::uuid AND merchant_id=${merchant}::uuid AND status='active' LIMIT 1`);
    if(!center[0])throw new Error('CENTER_NOT_FOUND');
    let reportingRate:number|null=null,reportingAmount:number|null=null;
    if(d.reportingCurrency){if(d.reportingCurrency===d.currency){reportingRate=1;reportingAmount=d.amount;}else{const rates=await tx.$queryRaw<Row[]>(Prisma.sql`SELECT rate FROM public.finance_fx_rates WHERE base_currency=${d.currency} AND quote_currency=${d.reportingCurrency} ORDER BY rate_date DESC,created_at DESC LIMIT 1`);if(rates[0]){reportingRate=Number(rates[0].rate);reportingAmount=number(d.amount*reportingRate);}}}
    const rows=await tx.$queryRaw<Row[]>(Prisma.sql`
      INSERT INTO public.finance_cost_entries (merchant_id,store_id,cost_center_id,category,description,amount,currency,competence_date,due_date,paid_on,status,source,supplier_name,external_reference,idempotency_key,reporting_currency,reporting_rate,reporting_amount,created_by,approved_by,approved_at)
      VALUES (${merchant}::uuid,${d.storeId||null}::uuid,${d.costCenterId}::uuid,${d.category},${d.description},${d.amount},${d.currency},${d.competenceDate}::date,${d.dueDate||null}::date,${d.paidOn||null}::date,${d.status},${d.source},${d.supplierName||null},${d.externalReference||null},${d.idempotencyKey||null},${d.reportingCurrency||null},${reportingRate},${reportingAmount},${a},${['approved','reserved','paid'].includes(d.status)?a:null},${['approved','reserved','paid'].includes(d.status)?new Date():null}) RETURNING *
    `);
    await tx.$executeRaw(Prisma.sql`INSERT INTO public.finance_operation_events (merchant_id,entity_type,entity_id,event_type,actor_reference,payload) VALUES (${merchant}::uuid,'cost_entry',${String(rows[0].id)}::uuid,'created',${a},${JSON.stringify({status:d.status,amount:d.amount,currency:d.currency})}::jsonb)`);
    return rows[0];
  });return res.status(201).json({success:true,data:result});}catch(error){if(error instanceof Error&&error.message==='CENTER_NOT_FOUND')return bad(res,'Centro de custo não encontrado ou inativo.',404);return internal(res,error,'Erro ao registar custo ou compromisso.');}
};

export const updateCostEntryStatus=async(req:AuthRequest,res:Response)=>{
  const merchant=merchantId(req);if(!merchant)return bad(res,'Merchant não autenticado.',401);
  const id=z.string().uuid().safeParse(req.params.id),parsed=statusInput.safeParse(req.body);if(!id.success||!parsed.success)return bad(res,'Identificador ou estado inválido.');
  const allowed:Record<string,string[]>={draft:['submitted','approved','cancelled'],submitted:['approved','cancelled'],approved:['reserved','paid','cancelled'],reserved:['paid','cancelled'],paid:[],cancelled:[]};
  const d=parsed.data,a=actor(req);
  try{const result=await prisma.$transaction(async tx=>{const current=(await tx.$queryRaw<Row[]>(Prisma.sql`SELECT id,status FROM public.finance_cost_entries WHERE id=${id.data}::uuid AND merchant_id=${merchant}::uuid FOR UPDATE`))[0];if(!current)throw new Error('NOT_FOUND');const from=String(current.status);if(from!==d.status&&!allowed[from]?.includes(d.status))throw new Error(`TRANSITION:${from}:${d.status}`);const rows=await tx.$queryRaw<Row[]>(Prisma.sql`UPDATE public.finance_cost_entries SET status=${d.status},paid_on=CASE WHEN ${d.status}='paid' THEN COALESCE(${d.paidOn||null}::date,CURRENT_DATE) ELSE paid_on END,approved_by=CASE WHEN ${d.status} IN ('approved','reserved','paid') THEN ${a} ELSE approved_by END,approved_at=CASE WHEN ${d.status} IN ('approved','reserved','paid') THEN COALESCE(approved_at,now()) ELSE approved_at END,metadata=metadata||${JSON.stringify({lastStatusNote:d.note||null})}::jsonb WHERE id=${id.data}::uuid RETURNING *`);await tx.$executeRaw(Prisma.sql`INSERT INTO public.finance_operation_events (merchant_id,entity_type,entity_id,event_type,actor_reference,payload) VALUES (${merchant}::uuid,'cost_entry',${id.data}::uuid,'status_changed',${a},${JSON.stringify({from,to:d.status,note:d.note||null})}::jsonb)`);return rows[0];});return res.json({success:true,data:result});}catch(error){if(error instanceof Error&&error.message==='NOT_FOUND')return bad(res,'Custo não encontrado.',404);if(error instanceof Error&&error.message.startsWith('TRANSITION:'))return bad(res,`Transição de estado inválida: ${error.message.split(':').slice(1).join(' → ')}.`,409);return internal(res,error,'Erro ao atualizar estado do custo.');}
};

const mapPlan=(r:Row)=>({id:r.id,planCode:r.plan_code,currency:r.currency,periodStart:isoDate(r.period_start),periodEnd:isoDate(r.period_end),sourceTotal:number(r.source_total),costTotal:number(r.cost_total),reserveTotal:number(r.reserve_total),distributableTotal:number(r.distributable_total),allocatedTotal:number(r.allocated_total),status:r.status,residualPolicy:r.residual_policy,sourceCount:count(r.source_count),allocationCount:count(r.allocation_count),reportingCurrency:r.reporting_currency,reportingRate:r.reporting_rate?Number(r.reporting_rate):null,reportingSource:r.reporting_source,reportingRateDate:isoDate(r.reporting_rate_date),metadata:r.metadata,createdAt:r.created_at,updatedAt:r.updated_at});

export const listDistributionPlans=async(req:AuthRequest,res:Response)=>{const merchant=merchantId(req);if(!merchant)return bad(res,'Merchant não autenticado.',401);const base=currency(req);try{const rows=await prisma.$queryRaw<Row[]>(Prisma.sql`SELECT p.*,COUNT(DISTINCT s.id) source_count,COUNT(DISTINCT a.id) allocation_count FROM public.finance_distribution_plans p LEFT JOIN public.finance_distribution_sources s ON s.distribution_plan_id=p.id LEFT JOIN public.finance_distribution_allocations a ON a.distribution_plan_id=p.id WHERE p.merchant_id=${merchant}::uuid AND upper(p.currency)=${base} GROUP BY p.id ORDER BY p.period_end DESC,p.created_at DESC LIMIT 200`);return res.json({success:true,data:rows.map(mapPlan)});}catch(error){return internal(res,error,'Erro ao carregar planos de distribuição.');}};

export const getDistributionPlan=async(req:AuthRequest,res:Response)=>{const merchant=merchantId(req);if(!merchant)return bad(res,'Merchant não autenticado.',401);const id=z.string().uuid().safeParse(req.params.id);if(!id.success)return bad(res,'Plano inválido.');try{const plans=await prisma.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM public.finance_distribution_plans WHERE id=${id.data}::uuid AND merchant_id=${merchant}::uuid LIMIT 1`);if(!plans[0])return bad(res,'Plano de distribuição não encontrado.',404);const [sources,costs,allocations]=await Promise.all([prisma.$queryRaw<Row[]>(Prisma.sql`SELECT ds.id,ds.amount,ds.source_reference,ps.statement_code,ps.external_reference,ps.status,ps.paid_on,pa.store_id,s.store_code,s.name store_name FROM public.finance_distribution_sources ds JOIN public.payout_statements ps ON ps.id=ds.payout_statement_id LEFT JOIN public.payout_statement_allocations pa ON pa.payout_statement_id=ps.id LEFT JOIN public.stores s ON s.id=pa.store_id WHERE ds.distribution_plan_id=${id.data}::uuid ORDER BY ps.paid_on,ps.statement_code`),prisma.$queryRaw<Row[]>(Prisma.sql`SELECT dc.amount,e.id,e.category,e.description,e.currency,e.status,e.competence_date,c.code cost_center_code,c.name cost_center_name FROM public.finance_distribution_costs dc JOIN public.finance_cost_entries e ON e.id=dc.cost_entry_id JOIN public.finance_cost_centers c ON c.id=e.cost_center_id WHERE dc.distribution_plan_id=${id.data}::uuid ORDER BY e.competence_date`),prisma.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM public.finance_distribution_allocations WHERE distribution_plan_id=${id.data}::uuid ORDER BY created_at,beneficiary_code`)]);return res.json({success:true,data:{...mapPlan(plans[0]),sources:sources.map(r=>({id:r.id,amount:number(r.amount),sourceReference:r.source_reference,statementCode:r.statement_code,externalReference:r.external_reference,payoutStatus:r.status,paidOn:isoDate(r.paid_on),storeId:r.store_id,storeCode:r.store_code,storeName:r.store_name})),costs:costs.map(r=>({id:r.id,amount:number(r.amount),category:r.category,description:r.description,currency:r.currency,status:r.status,competenceDate:isoDate(r.competence_date),costCenterCode:r.cost_center_code,costCenterName:r.cost_center_name})),allocations:allocations.map(r=>({id:r.id,beneficiaryCode:r.beneficiary_code,beneficiaryName:r.beneficiary_name,allocationType:r.allocation_type,percentage:r.percentage?Number(r.percentage):null,amount:number(r.amount),isResidual:Boolean(r.is_residual),status:r.status,externalReference:r.external_reference}))}});}catch(error){return internal(res,error,'Erro ao carregar o plano de distribuição.');}};

const bcbDate=(date:Date)=>`${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}-${date.getUTCFullYear()}`;
export const refreshEurBrlFxRate=async(req:AuthRequest,res:Response)=>{if(!merchantId(req))return bad(res,'Merchant não autenticado.',401);const parsed=typeof req.body?.rateDate==='string'?DATE.safeParse(req.body.rateDate):null;const initial=parsed?.success?new Date(`${parsed.data}T12:00:00Z`):new Date();try{let selected:Row|null=null,selectedDate:Date|null=null,raw:unknown=null;for(let offset=0;offset<=7&&!selected;offset++){const candidate=new Date(initial);candidate.setUTCDate(initial.getUTCDate()-offset);const day=bcbDate(candidate);const url=new URL('https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)');url.searchParams.set('@moeda',"'EUR'");url.searchParams.set('@dataInicial',`'${day}'`);url.searchParams.set('@dataFinalCotacao',`'${day}'`);url.searchParams.set('$format','json');url.searchParams.set('$orderby','dataHoraCotacao desc');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);const response=await fetch(url,{headers:{Accept:'application/json'},signal:controller.signal}).finally(()=>clearTimeout(timer));if(!response.ok)continue;const payload=await response.json() as {value?:Row[]};raw=payload;const values=Array.isArray(payload.value)?payload.value:[];selected=values.find(row=>row.tipoBoletim==='Fechamento')||values[0]||null;if(selected)selectedDate=candidate;}if(!selected||!selectedDate)return bad(res,'O Banco Central não devolveu cotação EUR/BRL nos últimos sete dias.',503);const rate=Number(selected.cotacaoVenda||selected.cotacaoCompra);if(!Number.isFinite(rate)||rate<=0)return bad(res,'Cotação EUR/BRL inválida recebida do BCB.',503);const rateDate=selectedDate.toISOString().slice(0,10),sourceTimestamp=selected.dataHoraCotacao?new Date(String(selected.dataHoraCotacao)):null;const rows=await prisma.$queryRaw<Row[]>(Prisma.sql`INSERT INTO public.finance_fx_rates (base_currency,quote_currency,rate,rate_date,source,rate_type,source_timestamp,raw_payload) VALUES ('EUR','BRL',${rate},${rateDate}::date,'BCB_PTAX','indicative',${sourceTimestamp},${JSON.stringify(raw||{})}::jsonb) ON CONFLICT (base_currency,quote_currency,rate_date,source,rate_type) DO UPDATE SET rate=EXCLUDED.rate,source_timestamp=EXCLUDED.source_timestamp,raw_payload=EXCLUDED.raw_payload,created_at=now() RETURNING *`);return res.json({success:true,data:{id:rows[0].id,baseCurrency:'EUR',quoteCurrency:'BRL',rate,rateDate,source:'BCB_PTAX',rateType:'indicative',sourceTimestamp}});}catch(error){return internal(res,error,'Erro ao atualizar cotação EUR/BRL.');}};
