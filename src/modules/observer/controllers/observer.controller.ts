import { Request, Response, Router } from 'express';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

// No Stripe API calls are made by this instance. The SDK is used only to
// verify webhook signatures, using each account's NEW observer endpoint secret.
const stripeVerifier = new Stripe('observer-signature-verification-only');

const SECRET_ENV: Record<string, string> = {
  vivachurch: 'STRIPE_OBSERVER_VIVACHURCH_WEBHOOK_SECRET',
  humanimpact: 'STRIPE_OBSERVER_HUMANIMPACT_WEBHOOK_SECRET'
};

const allowedEvents = new Set([
  'payment_intent.created',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'charge.succeeded',
  'charge.failed',
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'invoice.paid',
  'invoice.payment_failed',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'payout.canceled'
]);

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const positiveMinor = (value: unknown): bigint | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value) : null;

const money = (minor: bigint | null): string | null => {
  if (minor === null) return null;
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return sign + String(absolute / 100n) + '.' + String(absolute % 100n).padStart(2, '0');
};

// This endpoint NEVER writes to Transaction, Wallet, WalletMovement, or payouts.
export const receiveStripeObserver = async (req: Request, res: Response) => {
  const code = String(req.params.sourceCode ?? '').toLowerCase();
  const envName = SECRET_ENV[code];
  if (!envName) return res.status(404).json({ received: false });

  const secret = process.env[envName];
  if (!secret || !secret.startsWith('whsec_')) {
    return res.status(503).json({ received: false, error: 'observer_not_configured' });
  }
  if (!Buffer.isBuffer(req.body)) {
    return res.status(415).json({ received: false, error: 'raw_body_required' });
  }
  const signature = req.header('stripe-signature');
  if (!signature) return res.status(400).json({ received: false, error: 'missing_signature' });

  let event: Stripe.Event;
  try {
    event = stripeVerifier.webhooks.constructEvent(req.body, signature, secret);
  } catch {
    return res.status(400).json({ received: false, error: 'invalid_signature' });
  }

  if (!event.livemode) {
    return res.status(200).json({ received: true, ignored: 'test_event' });
  }
  if (!allowedEvents.has(event.type)) {
    return res.status(200).json({ received: true, ignored: 'unsupported_event' });
  }

  try {
    const source = await prisma.observerSource.findUnique({ where: { sourceCode: code } });
    if (!source || source.provider !== 'stripe' || source.mode !== 'observer') {
      return res.status(503).json({ received: false, error: 'observer_source_not_ready' });
    }

    const payload = event.data.object as unknown as Record<string, unknown>;
    const objectId = typeof payload.id === 'string' ? payload.id : null;
    const objectType = typeof payload.object === 'string' ? payload.object : null;
    const currency = typeof payload.currency === 'string' ? payload.currency.toUpperCase() : null;
    const amountMinor = positiveMinor(payload.amount);
    const eventAt = new Date(event.created * 1000);
    if (Number.isNaN(eventAt.getTime()) || !event.id) {
      return res.status(400).json({ received: false, error: 'invalid_event' });
    }

    await prisma.$transaction(async tx => {
      await tx.observerEvent.create({
        data: {
          sourceId: source.id, eventId: event.id, eventType: event.type,
          objectId, objectType, currency, amountMinor,
          objectStatus: typeof payload.status === 'string' ? payload.status : null,
          stripeCreatedAt: eventAt
        }
      });

      if (objectType === 'payment_intent' && objectId && currency && amountMinor !== null) {
        const receivedMinor = positiveMinor(payload.amount_received) ?? 0n;
        const status = typeof payload.status === 'string' ? payload.status : 'unknown';
        // Atomic conditional upsert: duplicate/out-of-order deliveries cannot regress state.
        await tx.$executeRaw`
          INSERT INTO "observer_payments"
            ("id", "source_id", "payment_intent_id", "currency", "amount_minor",
             "received_minor", "status", "last_event_created_at", "last_event_id",
             "created_at", "updated_at")
          VALUES
            (gen_random_uuid(), ${source.id}::uuid, ${objectId}, ${currency},
             ${amountMinor}, ${receivedMinor}, ${status}, ${eventAt}, ${event.id}, NOW(), NOW())
          ON CONFLICT ("source_id", "payment_intent_id")
          DO UPDATE SET
            "currency" = EXCLUDED."currency",
            "amount_minor" = EXCLUDED."amount_minor",
            "received_minor" = EXCLUDED."received_minor",
            "status" = EXCLUDED."status",
            "last_event_created_at" = EXCLUDED."last_event_created_at",
            "last_event_id" = EXCLUDED."last_event_id",
            "updated_at" = NOW()
          WHERE ("observer_payments"."last_event_created_at", "observer_payments"."last_event_id")
              < (EXCLUDED."last_event_created_at", EXCLUDED."last_event_id")
        `;
      }
    });

    return res.status(200).json({ received: true });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error('[STRIPE_OBSERVER_INGEST_ERROR]', {
      sourceCode: code, eventId: event.id, error: error instanceof Error ? error.message : 'unknown'
    });
    return res.status(500).json({ received: false, error: 'processing_failed' });
  }
};

const authMerchant = (req: AuthRequest, res: Response): string | null => {
  const id = req.user?.id;
  if (typeof id !== 'string') {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return null;
  }
  return id;
};

const sourceFilter = (req: AuthRequest) => {
  const sourceCode = String(req.query.sourceCode ?? '').trim().toLowerCase();
  return sourceCode ? { sourceCode } : {};
};

export const listObserverSources = async (req: AuthRequest, res: Response) => {
  const merchantId = authMerchant(req, res);
  if (!merchantId) return;
  const sources = await prisma.observerSource.findMany({
    where: { merchantId },
    select: {
      id: true, sourceCode: true, storeId: true, accountId: true,
      provider: true, mode: true, status: true, createdAt: true,
      store: { select: { name: true, currency: true } }
    },
    orderBy: { sourceCode: 'asc' }
  });
  return res.json({ success: true, data: sources });
};

export const getObserverSummary = async (req: AuthRequest, res: Response) => {
  const merchantId = authMerchant(req, res);
  if (!merchantId) return;
  const currency = String(req.query.currency ?? '').toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ success: false, error: 'invalid_currency' });
  }
  const sources = await prisma.observerSource.findMany({
    where: { merchantId, ...sourceFilter(req) },
    select: { id: true, sourceCode: true, storeId: true }
  });
  const sourceIds = sources.map(source => source.id);
  const groups = await prisma.observerPayment.groupBy({
    by: ['sourceId', 'currency', 'status'],
    where: { sourceId: { in: sourceIds }, ...(currency ? { currency } : {}) },
    _count: { _all: true },
    _sum: { amountMinor: true, receivedMinor: true }
  });
  return res.json({
    success: true,
    mode: 'observer',
    accounting: 'gross_payment_intents_only_no_settlement_or_netting',
    data: groups.map(group => ({
      sourceCode: sources.find(source => source.id === group.sourceId)?.sourceCode,
      currency: group.currency,
      status: group.status,
      count: group._count._all,
      amountMinor: String(group._sum.amountMinor ?? 0n),
      amount: money(group._sum.amountMinor),
      receivedMinor: String(group._sum.receivedMinor ?? 0n),
      received: money(group._sum.receivedMinor)
    }))
  });
};

export const listObserverEvents = async (req: AuthRequest, res: Response) => {
  const merchantId = authMerchant(req, res);
  if (!merchantId) return;
  const sources = await prisma.observerSource.findMany({
    where: { merchantId, ...sourceFilter(req) },
    select: { id: true, sourceCode: true }
  });
  const sourceIds = sources.map(source => source.id);
  const currency = String(req.query.currency ?? '').toUpperCase();
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 50;
  const events = await prisma.observerEvent.findMany({
    where: {
      sourceId: { in: sourceIds },
      ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {})
    },
    orderBy: { stripeCreatedAt: 'desc' },
    take: limit
  });
  return res.json({
    success: true,
    data: events.map(event => ({
      id: event.id, sourceCode: sources.find(s => s.id === event.sourceId)?.sourceCode,
      eventId: event.eventId, eventType: event.eventType,
      objectId: event.objectId, objectType: event.objectType,
      status: event.objectStatus, currency: event.currency,
      amountMinor: event.amountMinor === null ? null : String(event.amountMinor),
      amount: money(event.amountMinor),
      stripeCreatedAt: event.stripeCreatedAt, receivedAt: event.receivedAt
    }))
  });
};

export const observerIngressRoutes = Router();
observerIngressRoutes.post('/:sourceCode', receiveStripeObserver);

export const observerReadRoutes = Router();
observerReadRoutes.get('/sources', listObserverSources);
observerReadRoutes.get('/summary', getObserverSummary);
observerReadRoutes.get('/events', listObserverEvents);
