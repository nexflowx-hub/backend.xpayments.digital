import { Request, Response } from 'express';
import crypto from 'node:crypto';
import prisma from '../../../core/prisma';

const WRITE_SCOPES = new Set(['payments_write','payments','write']);
const PATH_ALLOWLIST = [
  /^\/payment_intents$/,
  /^\/payment_intents\/pi_[A-Za-z0-9_]+$/,
  /^\/payment_intents\/pi_[A-Za-z0-9_]+\/(confirm|cancel|capture)$/
];
const ZERO_DECIMAL_CHARGE_CURRENCIES = new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF'
]);

const getPresentedKey = (req: Request) => {
  const authorization = String(req.headers.authorization || '').trim();
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  if (authorization.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      return decoded.split(':', 1)[0]?.trim() || '';
    } catch {
      return '';
    }
  }
  return String(req.headers['x-api-key'] || '').trim();
};

const providerFamily = (value: unknown) =>
  String(value || '').trim().toLowerCase().split('-')[0].split('_')[0];

const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

const minorToMajor = (amountMinor: number, currencyUpper: string) => {
  // Stripe currently treats UGX charges using the backwards-compatible two-decimal representation.
  const divisor = ZERO_DECIMAL_CHARGE_CURRENCIES.has(currencyUpper) ? 1 : 100;
  return amountMinor / divisor;
};

const safeStripeSnapshot = (paymentIntent: any) => ({
  id: paymentIntent?.id ?? null,
  object: paymentIntent?.object ?? 'payment_intent',
  amount: paymentIntent?.amount ?? null,
  amountReceived: paymentIntent?.amount_received ?? null,
  amountCapturable: paymentIntent?.amount_capturable ?? null,
  currency: paymentIntent?.currency ?? null,
  status: paymentIntent?.status ?? null,
  livemode: paymentIntent?.livemode ?? null,
  paymentMethodTypes: paymentIntent?.payment_method_types ?? [],
  nextActionType: paymentIntent?.next_action?.type ?? null,
  latestCharge: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent?.latest_charge?.id ?? null,
  failureCode: paymentIntent?.last_payment_error?.code ?? null,
  declineCode: paymentIntent?.last_payment_error?.decline_code ?? null,
  failureMessage: paymentIntent?.last_payment_error?.message ?? null
});

const safeStripeError = (body: any) => ({
  type: body?.error?.type ?? null,
  code: body?.error?.code ?? null,
  declineCode: body?.error?.decline_code ?? null,
  message: body?.error?.message ?? null,
  paymentIntentId: typeof body?.error?.payment_intent?.id === 'string'
    ? body.error.payment_intent.id
    : null
});

async function resolveRelayContext(presentedKey: string) {
  const apiKey = await prisma.apiKey.findUnique({
    where: { key: presentedKey },
    include: {
      store: {
        select: { id:true, merchantId:true, storeCode:true, name:true, status:true }
      }
    }
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
      and upper(spp.activation_state)='ACTIVE'
    order by spp.updated_at desc
    limit 1
  `, apiKey.storeId, apiKey.store.merchantId);

  const route = rows[0];
  if (!route) throw new Error('STRIPE_ROUTE_NOT_CONFIGURED');
  if (providerFamily(route.account_provider) !== 'stripe' || providerFamily(route.vault_provider) !== 'stripe') {
    throw new Error('NOT_STRIPE_ROUTE');
  }

  const credentials = route.credentials && typeof route.credentials === 'object'
    ? route.credentials as Record<string, unknown>
    : {};
  const secretKey = String(credentials.secretKey || '').trim();
  if (!secretKey) throw new Error('STRIPE_SECRET_MISSING');

  const apiEnv = String(apiKey.environment || '').toLowerCase();
  const secretLive = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  const secretTest = secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
  if ((apiEnv === 'live' && !secretLive) || (apiEnv === 'test' && !secretTest)) {
    throw new Error('ENVIRONMENT_MISMATCH');
  }

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

function paymentIntentIdFromPath(path: string) {
  const match = path.match(/^\/payment_intents\/(pi_[A-Za-z0-9_]+)/);
  return match?.[1] ?? null;
}

function parseFormBody(req: Request) {
  const raw = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : typeof req.body === 'string'
      ? req.body
      : '';
  return new URLSearchParams(raw);
}

function readMerchantReference(form: URLSearchParams, fallback: string) {
  return String(
    form.get('metadata[merchant_reference]') ||
    form.get('metadata[order_id]') ||
    form.get('metadata[reference]') ||
    fallback
  ).trim().slice(0, 240);
}

function requestFieldNames(form: URLSearchParams) {
  return Array.from(new Set(Array.from(form.keys())))
    .filter(name => !/card\]\[number\]|card\]\[cvc\]|client_secret|secret/i.test(name))
    .slice(0, 200);
}

async function ensureOwnedPaymentIntent(ctx: any, paymentIntentId: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(`
    select id,merchant_id,store_id,gateway_vault_id,provider_id,reference,amount,currency,status,method,metadata,
           provider_connection_id,provider_payment_id
    from transactions
    where merchant_id=$1::uuid
      and store_id=$2::uuid
      and (provider_id=$3 or provider_payment_id=$3)
      and coalesce(source_mode,'')='STRIPE_COMPAT'
    limit 1
  `, ctx.apiKey.store.merchantId, ctx.apiKey.storeId, paymentIntentId);
  if (!rows[0]) throw new Error('PAYMENT_INTENT_NOT_OWNED');
  if (rows[0].provider_connection_id && String(rows[0].provider_connection_id) !== String(ctx.route.connection_id)) {
    throw new Error('PAYMENT_INTENT_ROUTE_MISMATCH');
  }
  return rows[0];
}

async function prepareCreateTransaction(ctx: any, form: URLSearchParams, idempotencyKey: string) {
  const amountRaw = String(form.get('amount') || '').trim();
  const amountMinor = Number(amountRaw);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > 99999999) {
    throw new Error('INVALID_AMOUNT');
  }

  const currencyUpper = String(form.get('currency') || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyUpper)) throw new Error('INVALID_CURRENCY');

  const idempotencyHash = idempotencyKey ? sha256(idempotencyKey) : '';
  const internalReference = idempotencyHash
    ? `STRIPE-${ctx.apiKey.store.storeCode}-${idempotencyHash.slice(0, 24)}`.slice(0, 250)
    : `STRIPE-${ctx.apiKey.store.storeCode}-${crypto.randomUUID()}`.slice(0, 250);
  const merchantReference = readMerchantReference(form, internalReference);
  const amountMajor = minorToMajor(amountMinor, currencyUpper);

  let transaction = idempotencyHash
    ? await prisma.transaction.findUnique({ where: { reference: internalReference } })
    : null;

  if (transaction) {
    if (transaction.merchantId !== ctx.apiKey.store.merchantId || transaction.storeId !== ctx.apiKey.storeId) {
      throw new Error('IDEMPOTENCY_OWNERSHIP_CONFLICT');
    }
    if (Number(transaction.amount) !== amountMajor || String(transaction.currency).toUpperCase() !== currencyUpper) {
      throw new Error('IDEMPOTENCY_PARAMETER_MISMATCH');
    }
  } else {
    transaction = await prisma.transaction.create({
      data: {
        merchantId: ctx.apiKey.store.merchantId,
        storeId: ctx.apiKey.storeId,
        gatewayVaultId: String(ctx.route.vault_id),
        reference: internalReference,
        amount: amountMajor,
        currency: currencyUpper,
        status: 'pending',
        method: 'card',
        gateway: String(ctx.route.vault_provider || 'stripe'),
        metadata: {
          stripeCompat: true,
          merchantReference,
          idempotencyKeyHash: idempotencyHash || null,
          providerConnectionId: String(ctx.route.connection_id),
          gatewayVaultId: String(ctx.route.vault_id)
        },
        rawRequest: {
          surface: 'STRIPE_COMPAT',
          requestFields: requestFieldNames(form),
          idempotencyKeyPresent: Boolean(idempotencyKey)
        }
      }
    });
    await prisma.$executeRawUnsafe(`
      update transactions
      set source_mode='STRIPE_COMPAT',
          provider_connection_id=$2::uuid
      where id=$1::uuid
    `, transaction.id, String(ctx.route.connection_id));
  }

  form.set('metadata[nexflowx_transaction_id]', transaction.id);
  form.set('metadata[merchant_reference]', merchantReference);
  form.set('metadata[xpayments_store_id]', ctx.apiKey.storeId);

  return { transaction, amountMinor, currencyUpper, merchantReference, form };
}

async function persistStripeResponse(transactionId: string, paymentIntent: any) {
  if (!paymentIntent || typeof paymentIntent.id !== 'string' || !paymentIntent.id.startsWith('pi_')) return;

  const currencyUpper = String(paymentIntent.currency || '').toUpperCase();
  const amountMinor = Number(paymentIntent.amount);
  const amountMajor = Number.isInteger(amountMinor) && /^[A-Z]{3}$/.test(currencyUpper)
    ? minorToMajor(amountMinor, currencyUpper)
    : undefined;
  const method = Array.isArray(paymentIntent.payment_method_types) && paymentIntent.payment_method_types[0]
    ? String(paymentIntent.payment_method_types[0]).replace(/-/g, '_')
    : undefined;
  const immediateStatus = paymentIntent.status === 'requires_payment_method'
    ? 'failed'
    : paymentIntent.status === 'canceled'
      ? 'canceled'
      : undefined;

  await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      providerId: paymentIntent.id,
      ...(amountMajor !== undefined ? { amount: amountMajor } : {}),
      ...(currencyUpper ? { currency: currencyUpper } : {}),
      ...(method ? { method } : {}),
      ...(immediateStatus ? { status: immediateStatus } : {}),
      rawResponse: safeStripeSnapshot(paymentIntent)
    }
  });

  await prisma.$executeRawUnsafe(`
    update transactions
    set provider_payment_id=$2
    where id=$1::uuid
  `, transactionId, paymentIntent.id);
}

export async function stripeRelay(req: Request, res: Response) {
  const presentedKey = getPresentedKey(req);
  if (!presentedKey || !presentedKey.startsWith('xp_')) {
    return res.status(401).json({
      error:{ type:'invalid_request_error', code:'api_key_invalid', message:'Invalid API Key provided' }
    });
  }

  const suffix = stripeSuffix(req);
  const path = plainPath(suffix);
  if (!PATH_ALLOWLIST.some(pattern => pattern.test(path))) {
    return res.status(404).json({
      error:{ type:'invalid_request_error', code:'resource_missing', message:'Stripe-compatible route not enabled by XPayments.' }
    });
  }

  const method = req.method.toUpperCase();
  if (!['GET','POST'].includes(method)) {
    return res.status(405).json({error:{type:'invalid_request_error',message:'Method not allowed'}});
  }

  let transaction: any = null;
  let providerCalled = false;

  try {
    const ctx = await resolveRelayContext(presentedKey);
    if (!ctx) {
      return res.status(401).json({
        error:{ type:'invalid_request_error', code:'api_key_invalid', message:'Invalid API Key provided' }
      });
    }

    const requestedStripeAccount = String(req.headers['stripe-account'] || '').trim();
    const configuredStripeAccount = String(ctx.credentials.stripeAccountId || ctx.credentials.accountId || '').trim();
    if (requestedStripeAccount && requestedStripeAccount !== configuredStripeAccount) {
      return res.status(403).json({
        error:{type:'invalid_request_error',code:'account_invalid',message:'Stripe-Account is not authorized for this Store.'}
      });
    }

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (method === 'POST' && contentType && contentType !== 'application/x-www-form-urlencoded') {
      return res.status(415).json({
        error:{type:'invalid_request_error',message:'Use application/x-www-form-urlencoded, as in Stripe v1.'}
      });
    }

    const idempotency = String(req.headers['idempotency-key'] || '').trim().slice(0, 255);
    let outboundBody: Buffer | undefined;
    const isCreate = method === 'POST' && path === '/payment_intents';
    const paymentIntentId = paymentIntentIdFromPath(path);

    if (isCreate) {
      const form = parseFormBody(req);
      const prepared = await prepareCreateTransaction(ctx, form, idempotency);
      transaction = prepared.transaction;
      outboundBody = Buffer.from(prepared.form.toString());
    } else {
      if (!paymentIntentId) throw new Error('PAYMENT_INTENT_ID_REQUIRED');
      transaction = await ensureOwnedPaymentIntent(ctx, paymentIntentId);
      if (method === 'POST') {
        const form = parseFormBody(req);
        if (/^\/payment_intents\/pi_[A-Za-z0-9_]+$/.test(path)) {
          const merchantReference = String(transaction?.metadata?.merchantReference || transaction.reference || '').slice(0, 240);
          form.set('metadata[nexflowx_transaction_id]', String(transaction.id));
          form.set('metadata[merchant_reference]', merchantReference);
          form.set('metadata[xpayments_store_id]', ctx.apiKey.storeId);
        }
        outboundBody = Buffer.from(form.toString());
      }
    }

    const headers: Record<string,string> = {
      Authorization: `Bearer ${ctx.secretKey}`,
      Accept: 'application/json'
    };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotency) headers['Idempotency-Key'] = idempotency;
    const stripeVersion = String(req.headers['stripe-version'] || '').trim();
    if (stripeVersion) headers['Stripe-Version'] = stripeVersion;
    if (requestedStripeAccount && configuredStripeAccount) headers['Stripe-Account'] = configuredStripeAccount;

    providerCalled = true;
    const upstream = await fetch(`https://api.stripe.com/v1${suffix}`, {
      method,
      headers,
      body: method === 'POST' ? outboundBody : undefined
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    const responseText = responseBody.toString('utf8');
    let parsed: any = null;
    try { parsed = JSON.parse(responseText); } catch { parsed = null; }

    if (transaction) {
      if (upstream.ok && parsed?.object === 'payment_intent') {
        await persistStripeResponse(String(transaction.id), parsed);
      } else if (!upstream.ok && isCreate) {
        await prisma.transaction.update({
          where: { id: String(transaction.id) },
          data: { status: 'failed', rawResponse: safeStripeError(parsed) }
        });
      }
    }

    for (const name of ['content-type','request-id','stripe-version','retry-after']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('X-XPayments-Relay','stripe-v1');
    res.setHeader('X-XPayments-Store', ctx.apiKey.store.storeCode);
    if (transaction?.id) res.setHeader('X-XPayments-Transaction-Id', String(transaction.id));

    void prisma.apiKey.update({ where:{id:ctx.apiKey.id}, data:{lastUsedAt:new Date()} }).catch(()=>undefined);
    console.log('[STRIPE RELAY]', {
      storeId:ctx.apiKey.storeId,
      transactionId:transaction?.id || null,
      connectionId:ctx.route.connection_id,
      vaultId:ctx.route.vault_id,
      method,path,status:upstream.status
    });
    return res.status(upstream.status).send(responseBody);
  } catch (error:any) {
    const code = String(error?.message || 'STRIPE_RELAY_ERROR');
    const safe: Record<string,[number,string]> = {
      STORE_NOT_ACTIVE:[409,'Store is not active.'],
      STRIPE_ROUTE_NOT_CONFIGURED:[409,'Stripe route is not configured for this Store.'],
      NOT_STRIPE_ROUTE:[409,'The active Store route is not Stripe.'],
      STRIPE_SECRET_MISSING:[409,'Stripe credentials are not configured.'],
      ENVIRONMENT_MISMATCH:[409,'API key environment does not match the Store Stripe credentials.'],
      INVALID_AMOUNT:[400,'Invalid positive integer amount in the currency minor unit.'],
      INVALID_CURRENCY:[400,'Invalid three-letter currency code.'],
      IDEMPOTENCY_OWNERSHIP_CONFLICT:[409,'Idempotency key conflicts with another Store transaction.'],
      IDEMPOTENCY_PARAMETER_MISMATCH:[409,'Idempotency key was already used with different amount or currency.'],
      PAYMENT_INTENT_NOT_OWNED:[404,'No such PaymentIntent for this XPayments Store.'],
      PAYMENT_INTENT_ROUTE_MISMATCH:[409,'PaymentIntent belongs to a different Store processing route.'],
      PAYMENT_INTENT_ID_REQUIRED:[400,'PaymentIntent id is required.']
    };

    if (transaction && !providerCalled && code === 'STRIPE_RELAY_ERROR') {
      // Intentionally no status mutation for unexpected pre-provider failures. A retry can safely resume.
    }

    if (safe[code]) {
      return res.status(safe[code][0]).json({
        error:{type:'invalid_request_error',code:code.toLowerCase(),message:safe[code][1]}
      });
    }

    console.error('[STRIPE RELAY ERROR]', {path,code,providerCalled});
    return res.status(502).json({
      error:{type:'api_error',code:'xpayments_relay_error',message:'Unable to process payment provider request.'}
    });
  }
}
