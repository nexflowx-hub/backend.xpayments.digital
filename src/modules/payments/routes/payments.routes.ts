import { Router } from 'express';

import * as directController from '../controllers/direct.controller';
import * as pixController from '../controllers/pix.controller';
import * as misticPayWebhook from '../controllers/misticpay.webhook';
import * as pixD1Webhook from '../controllers/pixgo.webhook';
import * as stripeWebhook from '../controllers/stripe.webhook';
import {
  syncStripeBalanceFromWebhookEvent
} from '../services/stripe-balance-sync.service';
import {
  StripeWebhookVerificationError,
  verifyStripeWebhookRequest
} from '../services/stripe-webhook-verification.service';

const router = Router();

router.post(
  '/charge',
  (req, res) => {
    const method = String(
      req.body?.payment_method_types?.[0] ?? ''
    )
      .trim()
      .toLowerCase()
      .replace(/-/g, '_');

    if (method === 'pix') {
      return pixController.processPixCharge(req, res);
    }

    return directController.processDirectCharge(req, res);
  }
);

/*
 * PIX provider webhooks are intentionally exposed under generic paths.
 * Provider identity is never returned by merchant-facing APIs or checkout UI.
 */
router.post(
  '/webhooks/misticpay',
  misticPayWebhook.handleMisticPayWebhook
);

router.post(
  '/webhooks/pix-d1',
  pixD1Webhook.handlePixD1Webhook
);

router.post(
  '/webhooks/stripe',
  async (req, res) => {
    let verified;

    try {
      verified = await verifyStripeWebhookRequest(req);
    } catch (error) {
      if (error instanceof StripeWebhookVerificationError) {
        console.warn('[STRIPE WEBHOOK REJECTED]', {
          code: error.code,
          statusCode: error.statusCode,
          hasSignature: Boolean(req.get('stripe-signature')),
          rejectedAt: new Date().toISOString()
        });

        return res.status(error.statusCode).json({
          received: false,
          error: {
            code: error.code,
            message: error.message
          }
        });
      }

      console.error('[STRIPE WEBHOOK VERIFICATION ERROR]', error);

      return res.status(500).json({
        received: false,
        error: {
          code: 'STRIPE_WEBHOOK_VERIFICATION_FAILED',
          message: 'Falha ao validar o webhook Stripe.'
        }
      });
    }

    req.body = verified.event;
    (req as any).verifiedStripeGatewayVaultId = verified.gatewayVaultId;
    (req as any).verifiedStripeProvider = verified.provider;

    const eventType = String(verified.event.type || '');

    console.log('[STRIPE WEBHOOK VERIFIED]', {
      eventId: verified.event.id,
      eventType,
      gatewayVaultId: verified.gatewayVaultId,
      provider: verified.provider
    });

    if (eventType === 'charge.updated') {
      try {
        const balanceSync = await syncStripeBalanceFromWebhookEvent(
          verified.event
        );

        console.log('[STRIPE BALANCE SYNC]', balanceSync);

        return res.status(200).json({
          received: true,
          eventType,
          gatewayProvider: verified.provider,
          balanceSync
        });
      } catch (error) {
        console.error('[STRIPE BALANCE SYNC ERROR]', error);

        return res.status(200).json({
          received: true,
          eventType,
          gatewayProvider: verified.provider,
          balanceSync: {
            synced: false,
            reason: 'sync_failed'
          }
        });
      }
    }

    await stripeWebhook.handleStripeWebhook(req, res);

    if (eventType === 'payment_intent.succeeded') {
      try {
        const balanceSync = await syncStripeBalanceFromWebhookEvent(
          verified.event
        );
        console.log('[STRIPE BALANCE SYNC]', balanceSync);
      } catch (error) {
        console.error('[STRIPE BALANCE SYNC ERROR]', error);
      }
    }
  }
);

export default router;
