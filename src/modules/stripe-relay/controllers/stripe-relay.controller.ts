import { Request, Response } from 'express';
import prisma from '../../../core/prisma';

const WRITE_SCOPES = new Set(['payments_write','payments','write']);
const PATH_ALLOWLIST = [
  /^\/payment_intents$/,
  /^\/payment_intents\/pi_[A-Za-z0-9_]+$/,
  /^\/payment_intents\/pi_[A-Za-z0-9_]+\/(confirm|cancel|capture)$/
];

const getPresentedKey = (req: Request) => {
  const authorization = String(req.headers.authorization || '').trim();
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  return String(req.headers['x-api-key'] || '').trim();
};

const providerFamily = (value: unknown) => String(value || '').trim().toLowerCase().split('-')[0].split('_')[0];

async function resolveRelayContext(presentedKey: string) {
  const apiKey = await prisma.apiKey.findUnique({
    where: { key: presentedKey },
    include: { store: { select: { id:true, merchantId:true, storeCode:true, name:true, status:true } } }
  });
  if (!apiKey) return null;
  if (!Array.isArray(apiKey.scopes) || !apiKey.scopes.some(scope => WRITE_SCOPES.has(String(scope)))) return null;
  if (apiKey.store.status !== 'active') throw new Error('STORE_NOT_ACTIVE');

  const rows = await prisma.$queryRawUnsafe<any[]>(`
    select spp.id profile_id,spp.activation_state,spp.processing_mode,
           pc.id connection_id,pc.status connection_status,pc.shadow_mode,pc.ledger_enabled,
           pa.provider account_provider,pa.environment account_environment,pa.external_account_id,
           gv.id vault_id,gv.provider vault_provider,gv.credentials,gv.is_active vault_active
    from store_processing_profiles spp
    join provider_connections pc on pc.id=spp.provider_connection_id
    join provider_accounts pa on pa.id=pc.provider_account_id
    join gateway_vaults gv on gv.id=pc.gateway_vault_id
    where spp.store_id=$1::uuid
      and spp.merchant_id=$2::uuid
      and pc.store_id=$1::uuid
      and pc.merchant_id=$2::uuid
      and lower(pc.status)='active'
      and gv.is_active=true
    order by case when upper(spp.activation_state)='ACTIVE' then 0 else 1 end,
             spp.updated_at desc
    limit 1
  `, apiKey.storeId, apiKey.store.merchantId);
  const route = rows[0];
  if (!route) throw new Error('STRIPE_ROUTE_NOT_CONFIGURED');
  if (providerFamily(route.account_provider) !== 'stripe' || providerFamily(route.vault_provider) !== 'stripe') throw new Error('NOT_STRIPE_ROUTE');
  const credentials = route.credentials && typeof route.credentials === 'object' ? route.credentials : {};
  const secretKey = String(credentials.secretKey || '').trim();
  if (!secretKey) throw new Error('STRIPE_SECRET_MISSING');

  const apiEnv = String(apiKey.environment || '').toLowerCase();
  const secretLive = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  const secretTest = secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
  if ((apiEnv === 'live' && !secretLive) || (apiEnv === 'test' && !secretTest)) throw new Error('ENVIRONMENT_MISMATCH');

  return { apiKey, route, credentials, secretKey };
}

function stripeSuffix(req: Request) {
  const marker = '/api/stripe/v1';
  const source = String(req.originalUrl || req.url || '');
  const idx = source.indexOf(marker);
  const suffix = idx >= 0 ? source.slice(idx + marker.length) : String(req.url || '');
  return suffix.startsWith('/') ? suffix : `/${suffix}`;
}

function plainPath(suffix: string) {
  return suffix.split('?')[0] || '/';
}

export async function stripeRelay(req: Request, res: Response) {
  const presentedKey = getPresentedKey(req);
  if (!presentedKey || !presentedKey.startsWith('xp_')) {
    return res.status(401).json({ error:{ type:'invalid_request_error', code:'api_key_invalid', message:'Invalid API Key provided' } });
  }

  const suffix = stripeSuffix(req);
  const path = plainPath(suffix);
  if (!PATH_ALLOWLIST.some(pattern => pattern.test(path))) {
    return res.status(404).json({ error:{ type:'invalid_request_error', code:'resource_missing', message:'Stripe-compatible route not enabled by XPayments.' } });
  }
  const method = req.method.toUpperCase();
  if (!['GET','POST'].includes(method)) return res.status(405).json({error:{type:'invalid_request_error',message:'Method not allowed'}});

  try {
    const ctx = await resolveRelayContext(presentedKey);
    if (!ctx) return res.status(401).json({ error:{ type:'invalid_request_error', code:'api_key_invalid', message:'Invalid API Key provided' } });

    const requestedStripeAccount = String(req.headers['stripe-account'] || '').trim();
    const configuredStripeAccount = String(ctx.credentials.stripeAccountId || ctx.credentials.accountId || '').trim();
    if (requestedStripeAccount && requestedStripeAccount !== configuredStripeAccount) {
      return res.status(403).json({error:{type:'invalid_request_error',code:'account_invalid',message:'Stripe-Account is not authorized for this Store.'}});
    }

    const headers: Record<string,string> = {
      Authorization: `Bearer ${ctx.secretKey}`,
      Accept: 'application/json'
    };
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (method === 'POST') {
      if (contentType && contentType !== 'application/x-www-form-urlencoded') {
        return res.status(415).json({error:{type:'invalid_request_error',message:'Use application/x-www-form-urlencoded, as in Stripe v1.'}});
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const idempotency = String(req.headers['idempotency-key'] || '').trim();
    if (idempotency) headers['Idempotency-Key'] = idempotency.slice(0,255);
    const stripeVersion = String(req.headers['stripe-version'] || '').trim();
    if (stripeVersion) headers['Stripe-Version'] = stripeVersion;
    if (requestedStripeAccount && configuredStripeAccount) headers['Stripe-Account'] = configuredStripeAccount;

    const body = method === 'POST'
      ? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : ''))
      : undefined;

    const upstream = await fetch(`https://api.stripe.com/v1${suffix}`, { method, headers, body });
    const responseBody = Buffer.from(await upstream.arrayBuffer());

    for (const name of ['content-type','request-id','stripe-version','retry-after']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('X-XPayments-Relay','stripe-v1');
    res.setHeader('X-XPayments-Store', ctx.apiKey.store.storeCode);

    void prisma.apiKey.update({where:{id:ctx.apiKey.id},data:{lastUsedAt:new Date()}}).catch(()=>undefined);
    console.log('[STRIPE RELAY]', {storeId:ctx.apiKey.storeId,connectionId:ctx.route.connection_id,vaultId:ctx.route.vault_id,method,path,status:upstream.status});
    return res.status(upstream.status).send(responseBody);
  } catch (error:any) {
    const code = String(error?.message || 'STRIPE_RELAY_ERROR');
    const safe: Record<string,[number,string]> = {
      STORE_NOT_ACTIVE:[409,'Store is not active.'],
      STRIPE_ROUTE_NOT_CONFIGURED:[409,'Stripe route is not configured for this Store.'],
      NOT_STRIPE_ROUTE:[409,'The active Store route is not Stripe.'],
      STRIPE_SECRET_MISSING:[409,'Stripe credentials are not configured.'],
      ENVIRONMENT_MISMATCH:[409,'API key environment does not match the Store Stripe credentials.']
    };
    if (safe[code]) return res.status(safe[code][0]).json({error:{type:'invalid_request_error',code:code.toLowerCase(),message:safe[code][1]}});
    console.error('[STRIPE RELAY ERROR]', {path,code});
    return res.status(502).json({error:{type:'api_error',code:'xpayments_relay_error',message:'Unable to reach payment provider.'}});
  }
}
