import { Response } from 'express';
import prisma from '../../../core/prisma';
import { ControlPlaneRequest } from '../middleware/control-plane-auth.middleware';

const intParam = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const textParam = (value: unknown, max = 200) => String(value ?? '').trim().slice(0, max);

export const getControlPlaneOverview = async (_req: ControlPlaneRequest, res: Response) => {
  try {
    const platform = await prisma.$queryRawUnsafe<any[]>(`
      select
        (select count(*)::int from merchants) as merchants,
        (select count(*)::int from merchants where status = 'active') as active_merchants,
        (select count(*)::int from stores) as stores,
        (select count(*)::int from stores where status = 'active') as active_stores,
        (select count(*)::int from transactions) as transactions,
        (select coalesce(sum(amount_eur), 0)::float8 from transactions where amount_eur is not null) as gross_amount_eur,
        (select count(*)::int from gateway_vaults) as gateway_vaults,
        (select count(*)::int from provider_accounts) as provider_accounts,
        (select count(*)::int from provider_connections) as provider_connections,
        (select count(*)::int from provider_connections where status = 'active') as active_provider_connections,
        (select count(*)::int from payout_requests where status not in ('CONFIRMED','REJECTED','CANCELLED')) as open_payout_requests,
        (select count(*)::int from service_orders where status not in ('DELIVERED','CANCELLED')) as open_expert_orders
    `);

    const wallets = await prisma.$queryRawUnsafe<any[]>(`
      select currency,
             coalesce(sum(balance),0)::float8 as balance,
             coalesce(sum(available),0)::float8 as available,
             coalesce(sum(reserved),0)::float8 as reserved,
             coalesce(sum(reconciliation_hold),0)::float8 as reconciliation_hold
      from wallets
      group by currency
      order by currency
    `);

    const stores = await prisma.$queryRawUnsafe<any[]>(`
      select status, count(*)::int as count
      from stores group by status order by status
    `);

    const connections = await prisma.$queryRawUnsafe<any[]>(`
      select mode, status, count(*)::int as count
      from provider_connections
      group by mode, status
      order by mode, status
    `);

    const expert = await prisma.$queryRawUnsafe<any[]>(`
      select status, payment_status, count(*)::int as count
      from service_orders
      group by status, payment_status
      order by status, payment_status
    `);

    return res.json({
      success: true,
      data: { platform: platform[0] || {}, wallets, storeStatus: stores, providerConnections: connections, expert }
    });
  } catch (error) {
    console.error('[control-plane.overview]', error);
    return res.status(500).json({ success: false, error: { code: 'CONTROL_PLANE_READ_ERROR', message: 'Falha ao carregar overview.' } });
  }
};

export const listControlPlaneMerchants = async (req: ControlPlaneRequest, res: Response) => {
  try {
    const limit = intParam(req.query.limit, 50, 1, 200);
    const offset = intParam(req.query.offset, 0, 0, 100000);
    const search = textParam(req.query.search);
    const status = textParam(req.query.status, 50);
    const tier = textParam(req.query.tier, 80);

    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (search) add(`(m.name ilike ? or m.email ilike ? or coalesce(m.company,'') ilike ? or m.id::text ilike ?)`, `%${search}%`);
    if (search) {
      const p = params.pop();
      const n = params.length;
      params.push(p, p, p, p);
      where[where.length - 1] = `(m.name ilike $${n+1} or m.email ilike $${n+2} or coalesce(m.company,'') ilike $${n+3} or m.id::text ilike $${n+4})`;
    }
    if (status) add('m.status = ?', status);
    if (tier) add('m.tier = ?', tier);

    const sqlWhere = where.join(' and ');
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      select
        m.id, m.email, m.name, m.company, m.tier, m.status, m.kyc_status,
        m.risk_score, m.created_at, m.updated_at,
        (select count(*)::int from stores s where s.merchant_id=m.id) as stores,
        (select count(*)::int from stores s where s.merchant_id=m.id and s.status='active') as active_stores,
        (select count(*)::int from transactions t where t.merchant_id=m.id) as transactions,
        (select coalesce(sum(t.amount_eur),0)::float8 from transactions t where t.merchant_id=m.id and t.amount_eur is not null) as volume_eur,
        (select count(*)::int from provider_connections pc where pc.merchant_id=m.id and pc.status='active') as active_provider_connections,
        (select count(*)::int from service_orders so where so.merchant_id=m.id) as expert_orders
      from merchants m
      where ${sqlWhere}
      order by m.created_at desc
      limit ${limit} offset ${offset}
    `, ...params);

    const countRows = await prisma.$queryRawUnsafe<any[]>(`
      select count(*)::int as count from merchants m where ${sqlWhere}
    `, ...params);

    return res.json({ success: true, data: { merchants: rows, total: countRows[0]?.count || 0, limit, offset } });
  } catch (error) {
    console.error('[control-plane.merchants]', error);
    return res.status(500).json({ success: false, error: { code: 'CONTROL_PLANE_READ_ERROR', message: 'Falha ao carregar Merchants.' } });
  }
};

export const getControlPlaneMerchant = async (req: ControlPlaneRequest, res: Response) => {
  try {
    const id = textParam(req.params.id, 80);
    const merchantRows = await prisma.$queryRawUnsafe<any[]>(`
      select id,email,name,company,tier,status,kyc_status,risk_score,created_at,updated_at
      from merchants where id=$1::uuid limit 1
    `, id);
    if (!merchantRows[0]) return res.status(404).json({ success:false, error:{ code:'NOT_FOUND', message:'Merchant não encontrado.' }});

    const [wallets, stores, connections, payouts, expertOrders, recentTransactions] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(`
        select id,currency,label,balance::float8,available::float8,reserved::float8,reconciliation_hold::float8,type,created_at,updated_at
        from wallets where merchant_id=$1::uuid order by currency
      `, id),
      prisma.$queryRawUnsafe<any[]>(`
        select s.id,s.store_code,s.name,s.domain,s.status,s.currency,s.revenue::float8,s.theme,s.created_at,
               spp.activation_state,spp.processing_mode,spp.runtime_generation,spp.provider_connection_id,
               pc.alias as provider_alias,pc.status as provider_status,pc.mode as provider_mode,pc.shadow_mode,pc.ledger_enabled,
               f.fee_basis,f.fee_percent_bps,f.fee_fixed_minor,f.active as fee_active
        from stores s
        left join lateral (
          select * from store_processing_profiles x where x.store_id=s.id order by x.updated_at desc limit 1
        ) spp on true
        left join provider_connections pc on pc.id=spp.provider_connection_id
        left join lateral (
          select * from store_fee_configs x where x.store_id=s.id and x.active=true and x.effective_from<=now()
            and (x.effective_to is null or x.effective_to>now()) order by x.effective_from desc limit 1
        ) f on true
        where s.merchant_id=$1::uuid order by s.created_at desc
      `, id),
      prisma.$queryRawUnsafe<any[]>(`
        select pc.id,pc.alias,pc.mode,pc.credential_mode,pc.capture_policy,pc.status,pc.shadow_mode,pc.ledger_enabled,
               pc.store_id,pc.gateway_vault_id,pc.provider_account_id,pa.provider,pa.external_account_id,pa.environment,pa.country,pa.default_currency
        from provider_connections pc join provider_accounts pa on pa.id=pc.provider_account_id
        where pc.merchant_id=$1::uuid order by pc.created_at desc
      `, id),
      prisma.$queryRawUnsafe<any[]>(`
        select id,request_code,store_id,wallet_id,currency,status,requested_amount::float8,external_reference,notes,
               requested_at,review_started_at,reviewed_at,rejected_at,cancelled_at,confirmed_at,created_at,updated_at
        from payout_requests where merchant_id=$1::uuid and deleted_at is null order by created_at desc limit 50
      `, id),
      prisma.$queryRawUnsafe<any[]>(`
        select so.id,so.order_code,so.status,so.progress,so.payment_status,so.payment_currency,so.payment_amount::float8,
               so.assigned_to,so.target_store_id,so.created_at,so.updated_at,o.code as offering_code,o.name as offering_name
        from service_orders so join service_offerings o on o.id=so.offering_id
        where so.merchant_id=$1::uuid order by so.created_at desc limit 50
      `, id),
      prisma.$queryRawUnsafe<any[]>(`
        select id,store_id,reference,customer,customer_email,amount::float8,currency,amount_eur::float8,status,method,country,
               gateway,risk_score,fee::float8,source_mode,provider_connection_id,provider_payment_id,created_at
        from transactions where merchant_id=$1::uuid order by created_at desc limit 50
      `, id)
    ]);

    return res.json({ success:true, data:{ merchant:merchantRows[0], wallets, stores, providerConnections:connections, payouts, expertOrders, recentTransactions } });
  } catch (error) {
    console.error('[control-plane.merchant-detail]', error);
    return res.status(500).json({ success:false, error:{ code:'CONTROL_PLANE_READ_ERROR', message:'Falha ao carregar Merchant.' }});
  }
};

export const listControlPlaneStores = async (req: ControlPlaneRequest, res: Response) => {
  try {
    const limit=intParam(req.query.limit,100,1,300), offset=intParam(req.query.offset,0,0,100000);
    const search=textParam(req.query.search), status=textParam(req.query.status,50), currency=textParam(req.query.currency,20), merchantId=textParam(req.query.merchantId,80);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select s.id,s.merchant_id,m.name as merchant_name,m.email as merchant_email,s.store_code,s.name,s.domain,s.status,s.currency,
             s.revenue::float8,s.theme,s.created_at,
             spp.activation_state,spp.processing_mode,spp.runtime_generation,spp.provider_connection_id,
             pc.alias as provider_alias,pc.mode as provider_mode,pc.status as provider_status,pc.shadow_mode,pc.ledger_enabled,
             f.id as fee_config_id,f.fee_basis,f.fee_percent_bps,f.fee_fixed_minor,f.min_fee_minor,f.max_fee_minor,f.active as fee_active,
             (select count(*)::int from transactions t where t.store_id=s.id) as transactions,
             (select coalesce(sum(t.amount_eur),0)::float8 from transactions t where t.store_id=s.id and t.amount_eur is not null) as volume_eur
      from stores s join merchants m on m.id=s.merchant_id
      left join lateral (select * from store_processing_profiles x where x.store_id=s.id order by x.updated_at desc limit 1) spp on true
      left join provider_connections pc on pc.id=spp.provider_connection_id
      left join lateral (select * from store_fee_configs x where x.store_id=s.id and x.active=true and x.effective_from<=now() and (x.effective_to is null or x.effective_to>now()) order by x.effective_from desc limit 1) f on true
      where ($1='' or s.name ilike '%'||$1||'%' or s.store_code ilike '%'||$1||'%' or m.name ilike '%'||$1||'%')
        and ($2='' or s.status=$2)
        and ($3='' or s.currency=$3)
        and ($4='' or s.merchant_id=$4::uuid)
      order by s.created_at desc limit ${limit} offset ${offset}
    `, search,status,currency,merchantId);
    return res.json({success:true,data:{stores:rows,limit,offset}});
  } catch(error){
    console.error('[control-plane.stores]',error);
    return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Stores.'}});
  }
};

export const listControlPlaneTransactions = async (req:ControlPlaneRequest,res:Response)=>{
  try{
    const limit=intParam(req.query.limit,100,1,300),offset=intParam(req.query.offset,0,0,100000);
    const merchantId=textParam(req.query.merchantId,80),storeId=textParam(req.query.storeId,80),status=textParam(req.query.status,50),currency=textParam(req.query.currency,20),search=textParam(req.query.search);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select t.id,t.merchant_id,m.name as merchant_name,t.store_id,s.store_code,s.name as store_name,t.gateway_vault_id,t.provider_connection_id,
             t.reference,t.customer,t.customer_email,t.amount::float8,t.currency,t.amount_eur::float8,t.status,t.method,t.country,t.gateway,
             t.risk_score,t.fee::float8,t.source_mode,t.provider_payment_id,t.provider_charge_id,t.provider_balance_transaction_id,
             t.provider_settlement_currency,t.created_at
      from transactions t join merchants m on m.id=t.merchant_id left join stores s on s.id=t.store_id
      where ($1='' or t.merchant_id=$1::uuid) and ($2='' or t.store_id=$2::uuid) and ($3='' or t.status=$3) and ($4='' or t.currency=$4)
        and ($5='' or t.reference ilike '%'||$5||'%' or coalesce(t.customer_email,'') ilike '%'||$5||'%' or coalesce(t.provider_payment_id,'') ilike '%'||$5||'%')
      order by t.created_at desc limit ${limit} offset ${offset}
    `,merchantId,storeId,status,currency,search);
    return res.json({success:true,data:{transactions:rows,limit,offset}});
  }catch(error){console.error('[control-plane.transactions]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Transactions.'}});}
};

export const listControlPlaneProviderAccounts = async (_req:ControlPlaneRequest,res:Response)=>{
  try{
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select pa.id,pa.provider,pa.external_account_id,pa.environment,pa.country,pa.default_currency,pa.status,pa.metadata,pa.created_at,pa.updated_at,
             (select count(*)::int from provider_connections pc where pc.provider_account_id=pa.id) as connections,
             (select count(*)::int from provider_connections pc where pc.provider_account_id=pa.id and pc.status='active') as active_connections
      from provider_accounts pa order by pa.provider,pa.created_at desc
    `);
    return res.json({success:true,data:{providerAccounts:rows}});
  }catch(error){console.error('[control-plane.provider-accounts]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Provider Accounts.'}});}
};

export const listControlPlaneProviderConnections = async (req:ControlPlaneRequest,res:Response)=>{
  try{
    const merchantId=textParam(req.query.merchantId,80),storeId=textParam(req.query.storeId,80),status=textParam(req.query.status,50);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select pc.id,pc.provider_account_id,pa.provider,pa.external_account_id,pa.environment,pc.merchant_id,m.name as merchant_name,
             pc.store_id,s.store_code,s.name as store_name,pc.gateway_vault_id,pc.alias,pc.mode,pc.credential_mode,pc.capture_policy,
             pc.status,pc.shadow_mode,pc.ledger_enabled,pc.metadata,pc.created_at,pc.updated_at
      from provider_connections pc
      join provider_accounts pa on pa.id=pc.provider_account_id join merchants m on m.id=pc.merchant_id join stores s on s.id=pc.store_id
      where ($1='' or pc.merchant_id=$1::uuid) and ($2='' or pc.store_id=$2::uuid) and ($3='' or pc.status=$3)
      order by pc.created_at desc
    `,merchantId,storeId,status);
    return res.json({success:true,data:{providerConnections:rows}});
  }catch(error){console.error('[control-plane.provider-connections]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Provider Connections.'}});}
};

export const listControlPlaneVaults = async (req:ControlPlaneRequest,res:Response)=>{
  try{
    const merchantId=textParam(req.query.merchantId,80),storeId=textParam(req.query.storeId,80);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select gv.id,gv.merchant_id,m.name as merchant_name,gv.store_id,s.store_code,s.name as store_name,gv.provider,gv.is_active,gv.created_at,
             coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(gv.credentials) k),'[]'::jsonb) as credential_fields,
             jsonb_build_object(
               'environment', gv.credentials->>'environment',
               'credentialMode', gv.credentials->>'credentialMode',
               'processingMode', gv.credentials->>'processingMode',
               'credentialState', gv.credentials->>'credentialState'
             ) as safe_credential_metadata,
             (gv.credentials is not null and gv.credentials <> '{}'::jsonb) as credentials_configured
      from gateway_vaults gv join merchants m on m.id=gv.merchant_id left join stores s on s.id=gv.store_id
      where ($1='' or gv.merchant_id=$1::uuid) and ($2='' or gv.store_id=$2::uuid)
      order by gv.created_at desc
    `,merchantId,storeId);
    return res.json({success:true,data:{gatewayVaults:rows,credentialsRedacted:true}});
  }catch(error){console.error('[control-plane.vaults]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Gateway Vaults.'}});}
};

export const listControlPlaneFees = async (req:ControlPlaneRequest,res:Response)=>{
  try{
    const merchantId=textParam(req.query.merchantId,80),storeId=textParam(req.query.storeId,80),active=textParam(req.query.active,10);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select f.id,f.merchant_id,m.name as merchant_name,f.store_id,s.store_code,s.name as store_name,s.currency,
             f.fee_basis,f.fee_percent_bps,f.fee_fixed_minor,f.min_fee_minor,f.max_fee_minor,f.active,f.effective_from,f.effective_to,f.metadata,f.created_at,f.updated_at
      from store_fee_configs f join merchants m on m.id=f.merchant_id join stores s on s.id=f.store_id
      where ($1='' or f.merchant_id=$1::uuid) and ($2='' or f.store_id=$2::uuid)
        and ($3='' or f.active=($3='true'))
      order by f.effective_from desc
    `,merchantId,storeId,active);
    return res.json({success:true,data:{feeConfigs:rows}});
  }catch(error){console.error('[control-plane.fees]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Fees.'}});}
};

export const listControlPlanePayouts = async (req:ControlPlaneRequest,res:Response)=>{
  try{
    const limit=intParam(req.query.limit,100,1,300),merchantId=textParam(req.query.merchantId,80),status=textParam(req.query.status,60);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select pr.id,pr.request_code,pr.merchant_id,m.name as merchant_name,pr.store_id,s.store_code,s.name as store_name,pr.wallet_id,
             pr.currency,pr.status,pr.requested_amount::float8,pr.external_reference,pr.notes,pr.requested_at,pr.review_started_at,
             pr.reviewed_at,pr.rejected_at,pr.cancelled_at,pr.confirmed_at,pr.confirmed_payout_statement_id,pr.version,pr.metadata,pr.created_at,pr.updated_at
      from payout_requests pr join merchants m on m.id=pr.merchant_id join stores s on s.id=pr.store_id
      where pr.deleted_at is null and ($1='' or pr.merchant_id=$1::uuid) and ($2='' or pr.status=$2)
      order by pr.created_at desc limit ${limit}
    `,merchantId,status);
    return res.json({success:true,data:{payoutRequests:rows,limit}});
  }catch(error){console.error('[control-plane.payouts]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Payout Requests.'}});}
};

export const listControlPlaneExpertOrders = async (req:ControlPlaneRequest,res:Response)=>{
  try{
    const limit=intParam(req.query.limit,100,1,300),status=textParam(req.query.status,80),paymentStatus=textParam(req.query.paymentStatus,50),search=textParam(req.query.search);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select so.id,so.order_code,so.merchant_id,m.name as merchant_name,m.email as merchant_email,o.code as offering_code,o.name as offering_name,
             so.status,so.progress,so.payment_status,so.payment_currency,so.payment_amount::float8,so.transaction_id,so.checkout_session_id,
             so.target_store_id,so.assigned_to,so.created_at,so.updated_at,
             step.code as current_step,step.label as current_step_label,step.status as current_step_status,
             (select count(*)::int from service_order_documents d where d.service_order_id=so.id) as documents,
             (select count(*)::int from service_order_payment_proofs p where p.service_order_id=so.id) as payment_proofs,
             (select count(*)::int from service_order_requirements r where r.service_order_id=so.id and r.status='APPROVED') as approved_requirements,
             (select count(*)::int from service_order_requirements r where r.service_order_id=so.id) as requirements
      from service_orders so join merchants m on m.id=so.merchant_id join service_offerings o on o.id=so.offering_id
      left join lateral (
        select x.code,x.label,x.status from service_order_steps x
        where x.service_order_id=so.id and x.status in ('IN_PROGRESS','BLOCKED') order by x.position limit 1
      ) step on true
      where ($1='' or so.status=$1) and ($2='' or so.payment_status=$2)
        and ($3='' or so.order_code ilike '%'||$3||'%' or m.name ilike '%'||$3||'%' or m.email ilike '%'||$3||'%' or o.name ilike '%'||$3||'%')
      order by so.created_at desc limit ${limit}
    `,status,paymentStatus,search);
    return res.json({success:true,data:{orders:rows,limit}});
  }catch(error){console.error('[control-plane.expert-orders]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Expert Orders.'}});}
};

export const listControlPlaneAudit = async (req:ControlPlaneRequest,res:Response)=>{
  try{
    const limit=intParam(req.query.limit,100,1,300),action=textParam(req.query.action,100),entityType=textParam(req.query.entityType,100);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select a.id,a.actor_user_id,u.email as actor_email,u.name as actor_name,u.role as actor_role,a.action,a.entity_type,a.entity_id,
             a.before_data,a.after_data,a.metadata,a.ip_address,a.created_at
      from control_plane_audit_logs a left join control_plane_users u on u.id=a.actor_user_id
      where ($1='' or a.action=$1) and ($2='' or a.entity_type=$2)
      order by a.created_at desc limit ${limit}
    `,action,entityType);
    return res.json({success:true,data:{audit:rows,limit}});
  }catch(error){console.error('[control-plane.audit-read]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Audit Log.'}});}
};

export const listControlPlaneUsers = async (_req:ControlPlaneRequest,res:Response)=>{
  try{
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select id,email,name,role,permissions,status,last_login_at,created_at,updated_at,
             (select count(*)::int from control_plane_sessions s where s.user_id=u.id and s.revoked_at is null and s.expires_at>now()) as active_sessions
      from control_plane_users u order by created_at desc
    `);
    return res.json({success:true,data:{users:rows}});
  }catch(error){console.error('[control-plane.users]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar utilizadores internos.'}});}
};
