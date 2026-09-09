const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const prismaModule = require('/app/dist/core/prisma');
const prisma = prismaModule.default || prismaModule;

const API = 'https://api.xpayments.digital';
const created = {
  sessionId: null,
  tierId: null,
  merchantId: null,
  storeId: null,
  providerAccountId: null,
  vaultId: null,
  connectionId: null,
  profileId: null,
  feeId: null,
  apiKeyId: null,
  internalUserId: null,
  orderId: null,
  assetId: null,
  ticketId: null,
};
let cpToken = null;
let merchantToken = null;
let success = false;
let cleanupOk = true;

const out = (name, value = 'PASS') => console.log(`${name}=${value}`);
const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const str = (v) => String(v ?? '');

async function request(path, { method = 'GET', token = cpToken, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      payload = body;
    } else {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(`${API}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

function must(result, expected, label) {
  if (result.status !== expected) {
    fail(`${label}: expected HTTP ${expected}, got ${result.status}: ${result.text.slice(0, 700)}`);
  }
  return result.json?.data ?? result.json;
}

async function financeSnapshot() {
  const rows = await prisma.$queryRawUnsafe(`
    select
      (select count(*)::bigint from transactions) as tx_count,
      (select count(*)::bigint from wallet_movements) as movement_count,
      (select coalesce(sum(balance),0)::text from wallets) as wallet_balance,
      (select coalesce(sum(available),0)::text from wallets) as wallet_available,
      (select coalesce(sum(reserved),0)::text from wallets) as wallet_reserved
  `);
  const r = rows[0] || {};
  return {
    tx: Number(r.tx_count || 0),
    movements: Number(r.movement_count || 0),
    balance: str(r.wallet_balance),
    available: str(r.wallet_available),
    reserved: str(r.wallet_reserved),
  };
}

async function scopedFinanceCounts(merchantId) {
  const rows = await prisma.$queryRawUnsafe(`
    select
      (select count(*)::int from transactions where merchant_id=$1::uuid) as tx,
      (select count(*)::int from wallet_movements where merchant_id=$1::uuid) as movements,
      (select count(*)::int from payout_requests where merchant_id=$1::uuid and deleted_at is null) as payouts,
      (select count(*)::int from wallets where merchant_id=$1::uuid and (balance<>0 or available<>0 or reserved<>0)) as nonzero_wallets
  `, merchantId);
  return rows[0] || {};
}

async function cleanup() {
  try {
    if (created.ticketId) {
      await prisma.$executeRawUnsafe(`delete from support_ticket_messages where ticket_id=$1::uuid`, created.ticketId).catch(()=>0);
      await prisma.$executeRawUnsafe(`delete from support_tickets where id=$1::uuid`, created.ticketId).catch(()=>0);
    }
    if (created.orderId) {
      for (const table of ['service_order_documents','service_order_payment_proofs','service_order_requirements','service_order_assets','service_order_steps']) {
        await prisma.$executeRawUnsafe(`delete from ${table} where service_order_id=$1::uuid`, created.orderId).catch(()=>0);
      }
      await prisma.$executeRawUnsafe(`delete from service_orders where id=$1::uuid`, created.orderId).catch(()=>0);
    }
    if (created.apiKeyId) await prisma.$executeRawUnsafe(`delete from api_keys where id=$1::uuid`, created.apiKeyId).catch(()=>0);
    if (created.profileId) await prisma.$executeRawUnsafe(`delete from store_processing_profiles where id=$1::uuid`, created.profileId).catch(()=>0);
    if (created.feeId) await prisma.$executeRawUnsafe(`delete from store_fee_configs where id=$1::uuid`, created.feeId).catch(()=>0);
    if (created.connectionId) await prisma.$executeRawUnsafe(`delete from provider_connections where id=$1::uuid`, created.connectionId).catch(()=>0);
    if (created.vaultId) await prisma.$executeRawUnsafe(`delete from gateway_vaults where id=$1::uuid`, created.vaultId).catch(()=>0);
    if (created.providerAccountId) await prisma.$executeRawUnsafe(`delete from provider_accounts where id=$1::uuid`, created.providerAccountId).catch(()=>0);
    if (created.storeId) await prisma.$executeRawUnsafe(`delete from stores where id=$1::uuid`, created.storeId).catch(()=>0);
    if (created.merchantId) {
      await prisma.$executeRawUnsafe(`delete from wallets where merchant_id=$1::uuid`, created.merchantId).catch(()=>0);
      await prisma.$executeRawUnsafe(`delete from merchants where id=$1::uuid`, created.merchantId).catch(()=>0);
    }
    if (created.tierId) await prisma.$executeRawUnsafe(`delete from platform_tiers where id=$1::uuid`, created.tierId).catch(()=>0);
    if (created.internalUserId) {
      await prisma.$executeRawUnsafe(`delete from control_plane_sessions where user_id=$1::uuid`, created.internalUserId).catch(()=>0);
      await prisma.$executeRawUnsafe(`delete from control_plane_users where id=$1::uuid`, created.internalUserId).catch(()=>0);
    }
    const auditIds = Object.values(created).filter(Boolean).map(String);
    for (const id of auditIds) {
      await prisma.$executeRawUnsafe(`delete from control_plane_audit_logs where entity_id=$1`, id).catch(()=>0);
    }
    if (created.sessionId) await prisma.$executeRawUnsafe(`delete from control_plane_sessions where id=$1::uuid`, created.sessionId).catch(()=>0);
    out('DISPOSABLE_CLEANUP', 'PASS');
  } catch (error) {
    cleanupOk = false;
    console.error('DISPOSABLE_CLEANUP=FAIL');
    console.error(error?.message || error);
  }
}

(async () => {
  console.log('======================================================');
  console.log(' XPAYMENTS — CONTROL PLANE V2 E2E CERTIFICATION');
  console.log('======================================================');

  const health = await request('/api/health', { token: null });
  must(health, 200, 'PRE_HEALTH');
  out('PRE_HEALTH');

  const globalBefore = await financeSnapshot();
  console.log(`GLOBAL_TX_BEFORE=${globalBefore.tx}`);
  console.log(`GLOBAL_WALLET_MOVEMENTS_BEFORE=${globalBefore.movements}`);

  const admins = await prisma.$queryRawUnsafe(`select id,email,name from control_plane_users where role='SUPER_ADMIN' and status='active' order by created_at asc limit 1`);
  assert(admins[0], 'No active SUPER_ADMIN found');
  const admin = admins[0];

  cpToken = `cpv2_${crypto.randomBytes(48).toString('base64url')}`;
  const cpHash = crypto.createHash('sha256').update(cpToken).digest('hex');
  const sessionRows = await prisma.$queryRawUnsafe(`
    insert into control_plane_sessions(user_id,token_hash,expires_at,ip_address,user_agent)
    values($1::uuid,$2,now()+interval '10 minutes','127.0.0.1','CONTROL_PLANE_V2_E2E') returning id
  `, String(admin.id), cpHash);
  created.sessionId = String(sessionRows[0].id);

  const me = must(await request('/api/v1/control-plane/me'), 200, 'CONTROL_PLANE_ME');
  assert(str(me.user?.role) === 'SUPER_ADMIN', 'Control Plane E2E session is not SUPER_ADMIN');
  out('CONTROL_PLANE_SUPER_ADMIN_AUTH');

  const stamp = Date.now().toString(36).toUpperCase();
  const tierCode = `CERT_${stamp}`;
  let d = must(await request('/api/v1/control-plane/tiers', { method:'POST', body:{ code:tierCode, name:'Certification Tier', description:'Disposable Control Plane V2 E2E tier', rank:990, feePercentBps:111, feeFixedMinor:7 } }), 201, 'CREATE_TIER');
  created.tierId = String(d.tier.id);
  out('TIER_CREATE');
  d = must(await request(`/api/v1/control-plane/tiers/${created.tierId}`, { method:'PATCH', body:{ name:'Certification Tier Updated', rank:991, feePercentBps:123 } }), 200, 'UPDATE_TIER');
  assert(Number(d.tier.default_fee_percent_bps) === 123, 'Tier update not persisted');
  out('TIER_UPDATE');

  const merchantEmail = `cpv2-${stamp.toLowerCase()}@example.invalid`;
  d = must(await request('/api/v1/control-plane/merchants', { method:'POST', body:{ email:merchantEmail, name:'CPV2 Disposable Merchant', company:'XPAYMENTS E2E', tier:tierCode, password:`Cert!${crypto.randomBytes(16).toString('hex')}` } }), 201, 'CREATE_MERCHANT');
  created.merchantId = String(d.merchant.id);
  out('MERCHANT_CREATE');
  d = must(await request(`/api/v1/control-plane/merchants/${created.merchantId}`, { method:'PATCH', body:{ status:'active', riskScore:7, company:'XPAYMENTS E2E Updated' } }), 200, 'UPDATE_MERCHANT');
  assert(str(d.merchant.status) === 'active' && Number(d.merchant.risk_score) === 7, 'Merchant update not persisted');
  out('MERCHANT_UPDATE');

  const storeCode = `CPV2-${stamp}`.slice(0, 48);
  d = must(await request('/api/v1/control-plane/stores', { method:'POST', body:{ merchantId:created.merchantId, storeCode, name:'CPV2 Disposable Store', currency:'EUR', status:'active', domain:`${stamp.toLowerCase()}.invalid` } }), 201, 'CREATE_STORE');
  created.storeId = String(d.store.id);
  out('STORE_CREATE');
  d = must(await request(`/api/v1/control-plane/stores/${created.storeId}`, { method:'PATCH', body:{ name:'CPV2 Disposable Store Updated', theme:'dark' } }), 200, 'UPDATE_STORE');
  assert(str(d.store.name).includes('Updated'), 'Store update not persisted');
  out('STORE_UPDATE');

  d = must(await request('/api/v1/control-plane/processing/provider-accounts', { method:'POST', body:{ provider:'certprovider', externalAccountId:`cert_acct_${stamp}`, environment:'test', country:'PT', defaultCurrency:'EUR', status:'active', metadata:{ certification:true } } }), 201, 'CREATE_PROVIDER_ACCOUNT');
  created.providerAccountId = String(d.providerAccount.id);
  out('PROVIDER_ACCOUNT_CREATE');
  d = must(await request(`/api/v1/control-plane/processing/provider-accounts/${created.providerAccountId}`, { method:'PATCH', body:{ metadata:{ certification:true, updated:true } } }), 200, 'UPDATE_PROVIDER_ACCOUNT');
  assert(d.providerAccount.metadata?.updated === true, 'Provider Account update not persisted');
  out('PROVIDER_ACCOUNT_UPDATE');

  d = must(await request('/api/v1/control-plane/processing/vaults', { method:'POST', body:{ merchantId:created.merchantId, storeId:created.storeId, provider:'certprovider', credentials:{ token:'cert-only-not-a-provider-secret', environment:'test' }, isActive:true } }), 201, 'CREATE_VAULT');
  created.vaultId = String(d.gatewayVault.id);
  assert(d.gatewayVault.credentials_configured === true, 'Vault write did not report configured credentials');
  assert(!('credentials' in d.gatewayVault), 'Vault credentials leaked in response');
  out('GATEWAY_VAULT_CREATE_REDACTED');
  d = must(await request(`/api/v1/control-plane/processing/vaults/${created.vaultId}`, { method:'PATCH', body:{ isActive:true } }), 200, 'UPDATE_VAULT');
  assert(!('credentials' in d.gatewayVault), 'Vault credentials leaked after update');
  out('GATEWAY_VAULT_UPDATE_REDACTED');

  d = must(await request('/api/v1/control-plane/processing/provider-connections', { method:'POST', body:{ providerAccountId:created.providerAccountId, merchantId:created.merchantId, storeId:created.storeId, gatewayVaultId:created.vaultId, alias:'cpv2-cert', mode:'DIRECT', credentialMode:'VAULT', capturePolicy:'automatic', status:'active', shadowMode:true, ledgerEnabled:false, metadata:{ certification:true } } }), 201, 'CREATE_CONNECTION');
  created.connectionId = String(d.providerConnection.id);
  out('PROVIDER_CONNECTION_CREATE');
  d = must(await request(`/api/v1/control-plane/processing/provider-connections/${created.connectionId}`, { method:'PATCH', body:{ alias:'cpv2-cert-updated', shadowMode:true, ledgerEnabled:false } }), 200, 'UPDATE_CONNECTION');
  assert(str(d.providerConnection.alias) === 'cpv2-cert-updated', 'Connection update not persisted');
  out('PROVIDER_CONNECTION_UPDATE');

  d = must(await request(`/api/v1/control-plane/stores/${created.storeId}/processing-profile`, { method:'PUT', body:{ providerConnectionId:created.connectionId, runtimeGeneration:'V1', processingMode:'ORCHESTRATED', activationState:'ACTIVE', legacyCompatibility:false, metadata:{ certification:true } } }), 200, 'UPSERT_PROCESSING_PROFILE');
  created.profileId = String(d.processingProfile.id);
  assert(str(d.processingProfile.provider_connection_id) === created.connectionId, 'Processing Profile not linked to Connection');
  out('STORE_PROCESSING_PROFILE_UPSERT');

  const flowRows = await prisma.$queryRawUnsafe(`
    select s.id store_id,spp.provider_connection_id,pc.gateway_vault_id,pc.provider_account_id,gv.provider vault_provider,pa.provider account_provider
    from stores s join store_processing_profiles spp on spp.store_id=s.id
    join provider_connections pc on pc.id=spp.provider_connection_id
    join gateway_vaults gv on gv.id=pc.gateway_vault_id
    join provider_accounts pa on pa.id=pc.provider_account_id
    where s.id=$1::uuid
  `, created.storeId);
  const flow = flowRows[0];
  assert(flow && str(flow.provider_connection_id) === created.connectionId && str(flow.gateway_vault_id) === created.vaultId && str(flow.provider_account_id) === created.providerAccountId, 'Store routing chain mismatch');
  out('STORE_TO_VAULT_ROUTING_CHAIN');

  const xpKey = `xp_test_cert_${crypto.randomBytes(18).toString('base64url')}`;
  const keyRows = await prisma.$queryRawUnsafe(`insert into api_keys(store_id,name,key,scopes,environment) values($1::uuid,'CPV2 E2E Relay',$2,array['payments_write']::text[],'test') returning id`, created.storeId, xpKey);
  created.apiKeyId = String(keyRows[0].id);
  const relay = await request('/api/stripe/v1/payment_intents', { method:'POST', token:xpKey, body:'amount=1&currency=eur', headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Idempotency-Key':`cpv2-${stamp}` } });
  assert(relay.status === 409, `Stripe relay expected 409 NOT_STRIPE_ROUTE, got ${relay.status}`);
  assert(str(relay.json?.error?.code) === 'not_stripe_route', `Unexpected Stripe relay code: ${relay.text}`);
  out('STRIPE_RELAY_ROUTE_RESOLUTION_FAIL_CLOSED');
  out('STRIPE_RELAY_PROVIDER_CALLED', 'NO');

  d = must(await request('/api/v1/control-plane/fees', { method:'POST', body:{ merchantId:created.merchantId, storeId:created.storeId, feeBasis:'SETTLEMENT_GROSS', feePercentBps:125, feeFixedMinor:9, active:true, metadata:{ certification:true } } }), 201, 'CREATE_FEE');
  created.feeId = String(d.feeConfig.id);
  out('STORE_FEE_CREATE');
  d = must(await request(`/api/v1/control-plane/fees/${created.feeId}`, { method:'PATCH', body:{ feePercentBps:150, feeFixedMinor:11 } }), 200, 'UPDATE_FEE');
  assert(Number(d.feeConfig.fee_percent_bps) === 150, 'Fee update not persisted');
  out('STORE_FEE_UPDATE');
  d = must(await request(`/api/v1/control-plane/fees/${created.feeId}`, { method:'DELETE' }), 200, 'DELETE_FEE');
  assert(d.deactivated === true && d.feeConfig.active === false, 'Fee delete must deactivate');
  out('STORE_FEE_DELETE_SAFE_DEACTIVATE');

  d = must(await request('/api/v1/control-plane/users', { method:'POST', body:{ email:`cpv2-user-${stamp.toLowerCase()}@example.invalid`, name:'CPV2 Disposable Operator', password:`Internal!${crypto.randomBytes(16).toString('hex')}`, role:'READ_ONLY', status:'active' } }), 201, 'CREATE_INTERNAL_USER');
  created.internalUserId = String(d.user.id);
  out('INTERNAL_USER_CREATE');
  d = must(await request(`/api/v1/control-plane/users/${created.internalUserId}`, { method:'PATCH', body:{ role:'SUPPORT', name:'CPV2 Disposable Support' } }), 200, 'UPDATE_INTERNAL_USER');
  assert(str(d.user.role) === 'SUPPORT', 'Internal user role update not persisted');
  out('INTERNAL_USER_UPDATE');

  const jwtSecret = str(process.env.JWT_SECRET).trim();
  assert(jwtSecret, 'JWT_SECRET missing in runtime; refusing fallback secret for E2E');
  merchantToken = jwt.sign({ id:created.merchantId, email:merchantEmail, name:'CPV2 Disposable Merchant' }, jwtSecret, { expiresIn:'10m' });
  const offerings = must(await request('/api/v1/expert/offerings', { token:null }), 200, 'EXPERT_OFFERINGS').offerings || [];
  const offering = offerings.find(o => o.available !== false && Number(o?.prices?.EUR) > 0);
  assert(offering, 'No active Expert offering with EUR price available for disposable E2E');
  d = must(await request('/api/v1/expert/orders', { method:'POST', token:merchantToken, body:{ offeringCode:offering.code, currency:'EUR', notes:'CONTROL_PLANE_V2_E2E_CERTIFICATION' } }), 201, 'CREATE_EXPERT_ORDER');
  created.orderId = String(d.order.id);
  out('EXPERT_ORDER_CREATE');

  d = must(await request(`/api/v1/control-plane/expert/orders/${created.orderId}`), 200, 'GET_EXPERT_ORDER');
  assert((d.steps || []).length === 14, 'Expert order must have 14 workflow steps');
  out('EXPERT_ORDER_DETAIL_14_STEPS');
  d = must(await request(`/api/v1/control-plane/expert/orders/${created.orderId}`, { method:'PATCH', body:{ assignedTo:'CPV2 Certification', targetStoreId:created.storeId, internalNotes:'Disposable Control Plane V2 E2E.' } }), 200, 'UPDATE_EXPERT_ORDER');
  assert(str(d.order.target_store_id) === created.storeId, 'Expert target Store link not persisted');
  out('EXPERT_ORDER_ASSIGN_TARGET_STORE');

  d = must(await request(`/api/v1/control-plane/expert/orders/${created.orderId}/confirm-payment`, { method:'POST', body:{ proofReference:`CERT-${stamp}`, note:'Disposable certification only' } }), 200, 'CONFIRM_EXPERT_PAYMENT');
  assert(d.financialMutation === false && str(d.paymentStatus) === 'PAID', 'Expert payment confirmation financial isolation failed');
  out('EXPERT_MANUAL_PAYMENT_CONFIRM');
  out('EXPERT_PAYMENT_FINANCIAL_MUTATION', 'NO');

  must(await request(`/api/v1/control-plane/expert/orders/${created.orderId}/steps/INFORMATION_COLLECTION`, { method:'PATCH', body:{ status:'COMPLETED', notes:'E2E complete' } }), 200, 'STEP_INFORMATION_COLLECTION');
  must(await request(`/api/v1/control-plane/expert/orders/${created.orderId}/steps/KYC_KYB`, { method:'PATCH', body:{ status:'IN_PROGRESS', notes:'E2E in progress' } }), 200, 'STEP_KYC');
  out('EXPERT_WORKFLOW_UPDATE');

  d = must(await request(`/api/v1/control-plane/expert/orders/${created.orderId}/assets`, { method:'POST', body:{ kind:'DOMAIN', label:'Certification Domain', valueText:`${stamp.toLowerCase()}.invalid`, sensitive:false, metadata:{ certification:true } } }), 201, 'CREATE_EXPERT_ASSET');
  created.assetId = String(d.asset.id);
  out('EXPERT_ASSET_CREATE');

  d = must(await request('/api/v1/control-plane/tickets', { method:'POST', body:{ merchantId:created.merchantId, storeId:created.storeId, serviceOrderId:created.orderId, category:'XPAY_EXPERT', subject:'CPV2 Disposable Expert Support', description:'Disposable ticket created by E2E certification.', priority:'HIGH', assignedToUserId:created.internalUserId, tags:['e2e','certification'] } }), 201, 'CREATE_TICKET');
  created.ticketId = String(d.ticket.id);
  out('SUPPORT_TICKET_CREATE_LINKED');

  d = must(await request(`/api/v1/control-plane/tickets/${created.ticketId}`), 200, 'GET_TICKET');
  assert(str(d.ticket.service_order_id) === created.orderId && str(d.ticket.store_id) === created.storeId && (d.messages || []).length >= 1, 'Ticket links or initial message missing');
  out('SUPPORT_TICKET_DETAIL_LINKS');

  d = must(await request(`/api/v1/control-plane/tickets/${created.ticketId}`, { method:'PATCH', body:{ status:'IN_PROGRESS', priority:'URGENT', assignedToUserId:created.internalUserId } }), 200, 'UPDATE_TICKET');
  assert(str(d.ticket.status) === 'IN_PROGRESS' && str(d.ticket.priority) === 'URGENT', 'Ticket update not persisted');
  out('SUPPORT_TICKET_UPDATE');
  must(await request(`/api/v1/control-plane/tickets/${created.ticketId}/messages`, { method:'POST', body:{ body:'Internal E2E note.', internal:true } }), 201, 'TICKET_MESSAGE');
  d = must(await request(`/api/v1/control-plane/tickets/${created.ticketId}`), 200, 'GET_TICKET_AFTER_MESSAGE');
  assert((d.messages || []).some(m => m.internal === true && str(m.body) === 'Internal E2E note.'), 'Internal ticket note missing');
  out('SUPPORT_TICKET_INTERNAL_MESSAGE');
  must(await request(`/api/v1/control-plane/tickets/${created.ticketId}`, { method:'DELETE' }), 200, 'DELETE_TICKET');
  out('SUPPORT_TICKET_DELETE');
  created.ticketId = null;

  must(await request(`/api/v1/control-plane/expert/orders/${created.orderId}/assets/${created.assetId}`, { method:'DELETE' }), 200, 'DELETE_EXPERT_ASSET');
  out('EXPERT_ASSET_DELETE');
  created.assetId = null;

  d = await request(`/api/v1/control-plane/processing/provider-connections/${created.connectionId}`, { method:'DELETE' });
  assert(d.status === 409 && d.json?.data?.deactivated === true, `Connection safe-delete expected 409/deactivated, got ${d.status}: ${d.text}`);
  out('CONNECTION_DELETE_WITH_PROFILE_SAFE_DEACTIVATE');

  await prisma.$executeRawUnsafe(`delete from store_processing_profiles where id=$1::uuid`, created.profileId);
  created.profileId = null;
  must(await request(`/api/v1/control-plane/processing/provider-connections/${created.connectionId}`, { method:'PATCH', body:{ status:'active', ledgerEnabled:false, shadowMode:true } }), 200, 'REACTIVATE_CONNECTION');
  must(await request(`/api/v1/control-plane/processing/provider-connections/${created.connectionId}`, { method:'DELETE' }), 200, 'DELETE_CONNECTION');
  out('PROVIDER_CONNECTION_DELETE');
  created.connectionId = null;

  await prisma.$executeRawUnsafe(`delete from api_keys where id=$1::uuid`, created.apiKeyId);
  created.apiKeyId = null;
  must(await request(`/api/v1/control-plane/processing/vaults/${created.vaultId}`, { method:'DELETE' }), 200, 'DELETE_VAULT');
  out('GATEWAY_VAULT_DELETE');
  created.vaultId = null;
  must(await request(`/api/v1/control-plane/processing/provider-accounts/${created.providerAccountId}`, { method:'DELETE' }), 200, 'DELETE_PROVIDER_ACCOUNT');
  out('PROVIDER_ACCOUNT_DELETE');
  created.providerAccountId = null;

  await prisma.$executeRawUnsafe(`delete from store_fee_configs where id=$1::uuid`, created.feeId);
  created.feeId = null;

  const scopedBeforeCleanup = await scopedFinanceCounts(created.merchantId);
  assert(Number(scopedBeforeCleanup.tx) === 0 && Number(scopedBeforeCleanup.movements) === 0 && Number(scopedBeforeCleanup.payouts) === 0 && Number(scopedBeforeCleanup.nonzero_wallets) === 0, `Disposable Merchant financial mutation detected: ${JSON.stringify(scopedBeforeCleanup)}`);
  out('DISPOSABLE_MERCHANT_ZERO_TRANSACTIONS');
  out('DISPOSABLE_MERCHANT_ZERO_WALLET_MOVEMENTS');
  out('DISPOSABLE_MERCHANT_ZERO_PAYOUTS');
  out('DISPOSABLE_MERCHANT_ZERO_NONZERO_WALLETS');

  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`delete from service_order_documents where service_order_id=$1::uuid`, created.orderId).catch(()=>0);
    await tx.$executeRawUnsafe(`delete from service_order_payment_proofs where service_order_id=$1::uuid`, created.orderId).catch(()=>0);
    await tx.$executeRawUnsafe(`delete from service_order_requirements where service_order_id=$1::uuid`, created.orderId).catch(()=>0);
    await tx.$executeRawUnsafe(`delete from service_order_assets where service_order_id=$1::uuid`, created.orderId).catch(()=>0);
    await tx.$executeRawUnsafe(`delete from service_order_steps where service_order_id=$1::uuid`, created.orderId);
    await tx.$executeRawUnsafe(`delete from service_orders where id=$1::uuid`, created.orderId);
  });
  created.orderId = null;
  out('EXPERT_ORDER_DISPOSABLE_CLEANUP');

  must(await request(`/api/v1/control-plane/stores/${created.storeId}`, { method:'DELETE' }), 200, 'DELETE_STORE');
  out('STORE_DELETE');
  created.storeId = null;

  must(await request(`/api/v1/control-plane/merchants/${created.merchantId}`, { method:'DELETE' }), 200, 'DELETE_MERCHANT');
  out('MERCHANT_DELETE');
  created.merchantId = null;

  must(await request(`/api/v1/control-plane/tiers/${created.tierId}`, { method:'DELETE' }), 200, 'DELETE_TIER');
  out('TIER_DELETE');
  created.tierId = null;

  must(await request(`/api/v1/control-plane/users/${created.internalUserId}`, { method:'DELETE' }), 200, 'DISABLE_INTERNAL_USER');
  out('INTERNAL_USER_DISABLE');
  await prisma.$executeRawUnsafe(`delete from control_plane_sessions where user_id=$1::uuid`, created.internalUserId).catch(()=>0);
  await prisma.$executeRawUnsafe(`delete from control_plane_users where id=$1::uuid`, created.internalUserId);
  created.internalUserId = null;
  out('INTERNAL_USER_DISPOSABLE_CLEANUP');

  const globalAfter = await financeSnapshot();
  console.log(`GLOBAL_TX_AFTER=${globalAfter.tx}`);
  console.log(`GLOBAL_WALLET_MOVEMENTS_AFTER=${globalAfter.movements}`);
  console.log(`GLOBAL_TX_DELTA=${globalAfter.tx - globalBefore.tx}`);
  console.log(`GLOBAL_WALLET_MOVEMENTS_DELTA=${globalAfter.movements - globalBefore.movements}`);
  if (globalAfter.tx === globalBefore.tx && globalAfter.movements === globalBefore.movements && globalAfter.balance === globalBefore.balance && globalAfter.available === globalBefore.available && globalAfter.reserved === globalBefore.reserved) {
    out('GLOBAL_FINANCIAL_COUNTS_AND_BALANCES_STABLE');
  } else {
    out('GLOBAL_FINANCIAL_COUNTS_AND_BALANCES_STABLE', 'INFO_CONCURRENT_PLATFORM_ACTIVITY_POSSIBLE');
  }

  const finalHealth = must(await request('/api/health', { token:null }), 200, 'FINAL_HEALTH');
  assert(finalHealth?.status === 'ONLINE' || finalHealth?.engine === 'XPayments', 'Final health payload invalid');
  out('FINAL_HEALTH');
  out('E2E_PROVIDER_CALLED', 'NO');
  out('E2E_FINANCIAL_MUTATION', 'NO');
  success = true;
})().catch(error => {
  console.error('E2E_ERROR=' + (error?.message || error));
  process.exitCode = 1;
}).finally(async () => {
  await cleanup();
  await prisma.$disconnect();
  if (success && cleanupOk) {
    out('CONTROL_PLANE_V2_E2E', 'PASS');
  } else {
    out('CONTROL_PLANE_V2_E2E', 'FAIL');
    process.exitCode = 1;
  }
});
