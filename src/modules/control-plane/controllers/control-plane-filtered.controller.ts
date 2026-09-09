import { Response } from 'express';
import prisma from '../../../core/prisma';
import { ControlPlaneRequest } from '../middleware/control-plane-auth.middleware';

const intParam=(v:unknown,f:number,min:number,max:number)=>{const n=Number.parseInt(String(v??''),10);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):f;};
const text=(v:unknown,max=200)=>String(v??'').trim().slice(0,max);

export const listControlPlaneStoresSafe=async(req:ControlPlaneRequest,res:Response)=>{
  try{
    const limit=intParam(req.query.limit,100,1,300),offset=intParam(req.query.offset,0,0,100000);
    const search=text(req.query.search),status=text(req.query.status,50),currency=text(req.query.currency,20),merchantId=text(req.query.merchantId,80);
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
        and ($2='' or s.status=$2) and ($3='' or s.currency=$3) and ($4='' or s.merchant_id::text=$4)
      order by s.created_at desc limit ${limit} offset ${offset}
    `,search,status,currency,merchantId);
    return res.json({success:true,data:{stores:rows,limit,offset}});
  }catch(error){console.error('[control-plane.stores]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Stores.'}});}
};

export const listControlPlaneTransactionsSafe=async(req:ControlPlaneRequest,res:Response)=>{
  try{
    const limit=intParam(req.query.limit,100,1,300),offset=intParam(req.query.offset,0,0,100000);
    const merchantId=text(req.query.merchantId,80),storeId=text(req.query.storeId,80),status=text(req.query.status,50),currency=text(req.query.currency,20),search=text(req.query.search);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select t.id,t.merchant_id,m.name as merchant_name,t.store_id,s.store_code,s.name as store_name,t.gateway_vault_id,t.provider_connection_id,
             t.reference,t.customer,t.customer_email,t.amount::float8,t.currency,t.amount_eur::float8,t.status,t.method,t.country,t.gateway,
             t.risk_score,t.fee::float8,t.source_mode,t.provider_payment_id,t.provider_charge_id,t.provider_balance_transaction_id,
             t.provider_settlement_currency,t.created_at
      from transactions t join merchants m on m.id=t.merchant_id left join stores s on s.id=t.store_id
      where ($1='' or t.merchant_id::text=$1) and ($2='' or t.store_id::text=$2) and ($3='' or t.status=$3) and ($4='' or t.currency=$4)
        and ($5='' or t.reference ilike '%'||$5||'%' or coalesce(t.customer_email,'') ilike '%'||$5||'%' or coalesce(t.provider_payment_id,'') ilike '%'||$5||'%')
      order by t.created_at desc limit ${limit} offset ${offset}
    `,merchantId,storeId,status,currency,search);
    return res.json({success:true,data:{transactions:rows,limit,offset}});
  }catch(error){console.error('[control-plane.transactions]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Transactions.'}});}
};

export const listControlPlaneProviderConnectionsSafe=async(req:ControlPlaneRequest,res:Response)=>{
  try{
    const merchantId=text(req.query.merchantId,80),storeId=text(req.query.storeId,80),status=text(req.query.status,50);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select pc.id,pc.provider_account_id,pa.provider,pa.external_account_id,pa.environment,pc.merchant_id,m.name as merchant_name,
             pc.store_id,s.store_code,s.name as store_name,pc.gateway_vault_id,pc.alias,pc.mode,pc.credential_mode,pc.capture_policy,
             pc.status,pc.shadow_mode,pc.ledger_enabled,pc.metadata,pc.created_at,pc.updated_at
      from provider_connections pc
      join provider_accounts pa on pa.id=pc.provider_account_id join merchants m on m.id=pc.merchant_id join stores s on s.id=pc.store_id
      where ($1='' or pc.merchant_id::text=$1) and ($2='' or pc.store_id::text=$2) and ($3='' or pc.status=$3)
      order by pc.created_at desc
    `,merchantId,storeId,status);
    return res.json({success:true,data:{providerConnections:rows}});
  }catch(error){console.error('[control-plane.provider-connections]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Provider Connections.'}});}
};

export const listControlPlaneVaultsSafe=async(req:ControlPlaneRequest,res:Response)=>{
  try{
    const merchantId=text(req.query.merchantId,80),storeId=text(req.query.storeId,80);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select gv.id,gv.merchant_id,m.name as merchant_name,gv.store_id,s.store_code,s.name as store_name,gv.provider,gv.is_active,gv.created_at,
             coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(gv.credentials) k),'[]'::jsonb) as credential_fields,
             jsonb_build_object('environment',gv.credentials->>'environment','credentialMode',gv.credentials->>'credentialMode','processingMode',gv.credentials->>'processingMode','credentialState',gv.credentials->>'credentialState') as safe_credential_metadata,
             (gv.credentials is not null and gv.credentials<>'{}'::jsonb) as credentials_configured
      from gateway_vaults gv join merchants m on m.id=gv.merchant_id left join stores s on s.id=gv.store_id
      where ($1='' or gv.merchant_id::text=$1) and ($2='' or gv.store_id::text=$2)
      order by gv.created_at desc
    `,merchantId,storeId);
    return res.json({success:true,data:{gatewayVaults:rows,credentialsRedacted:true}});
  }catch(error){console.error('[control-plane.vaults]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Gateway Vaults.'}});}
};

export const listControlPlaneFeesSafe=async(req:ControlPlaneRequest,res:Response)=>{
  try{
    const merchantId=text(req.query.merchantId,80),storeId=text(req.query.storeId,80),active=text(req.query.active,10);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select f.id,f.merchant_id,m.name as merchant_name,f.store_id,s.store_code,s.name as store_name,s.currency,
             f.fee_basis,f.fee_percent_bps,f.fee_fixed_minor,f.min_fee_minor,f.max_fee_minor,f.active,f.effective_from,f.effective_to,f.metadata,f.created_at,f.updated_at
      from store_fee_configs f join merchants m on m.id=f.merchant_id join stores s on s.id=f.store_id
      where ($1='' or f.merchant_id::text=$1) and ($2='' or f.store_id::text=$2) and ($3='' or f.active=($3='true'))
      order by f.effective_from desc
    `,merchantId,storeId,active);
    return res.json({success:true,data:{feeConfigs:rows}});
  }catch(error){console.error('[control-plane.fees]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Fees.'}});}
};

export const listControlPlanePayoutsSafe=async(req:ControlPlaneRequest,res:Response)=>{
  try{
    const limit=intParam(req.query.limit,100,1,300),merchantId=text(req.query.merchantId,80),status=text(req.query.status,60);
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      select pr.id,pr.request_code,pr.merchant_id,m.name as merchant_name,pr.store_id,s.store_code,s.name as store_name,pr.wallet_id,
             pr.currency,pr.status,pr.requested_amount::float8,pr.external_reference,pr.notes,pr.requested_at,pr.review_started_at,
             pr.reviewed_at,pr.rejected_at,pr.cancelled_at,pr.confirmed_at,pr.confirmed_payout_statement_id,pr.version,pr.metadata,pr.created_at,pr.updated_at
      from payout_requests pr join merchants m on m.id=pr.merchant_id join stores s on s.id=pr.store_id
      where pr.deleted_at is null and ($1='' or pr.merchant_id::text=$1) and ($2='' or pr.status=$2)
      order by pr.created_at desc limit ${limit}
    `,merchantId,status);
    return res.json({success:true,data:{payoutRequests:rows,limit}});
  }catch(error){console.error('[control-plane.payouts]',error);return res.status(500).json({success:false,error:{code:'CONTROL_PLANE_READ_ERROR',message:'Falha ao carregar Payout Requests.'}});}
};
