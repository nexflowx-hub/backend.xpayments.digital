import { Router } from 'express';

import * as directController from '../controllers/direct.controller';
import * as stripeWebhook from '../controllers/stripe.webhook';
import {
  syncStripeBalanceFromWebhookEvent
} from '../services/stripe-balance-sync.service';

const router = Router();

// ==========================================
// ROTA SERVER-TO-SERVER (S2S)
// ==========================================
router.post(
  '/charge',
  directController.processDirectCharge
);

// ==========================================
// ROTA INBOUND DE PROVEDORES
// ==========================================
// A Stripe fará o POST para
// /api/v1/payments/webhooks/stripe
//
// Finance V4.1:
// - payment_intent.succeeded mantém o fluxo financeiro existente;
// - depois tenta persistir fee/status/available_on informativos;
// - charge.updated funciona como segunda oportunidade quando a
//   Balance Transaction ainda não estava pronta no primeiro evento;
// - esta sincronização NÃO altera wallet, status do movimento ou payout.
router.post(
  '/webhooks/stripe',
  async (req, res) => {
    const eventType = String(
      req.body?.type || ''
    );

    if (eventType === 'charge.updated') {
      try {
        const balanceSync =
          await syncStripeBalanceFromWebhookEvent(
            req.body
          );

        console.log(
          '[STRIPE BALANCE SYNC]',
          balanceSync
        );

        return res.status(200).json({
          received: true,
          eventType,
          balanceSync
        });
      } catch (error) {
        console.error(
          '[STRIPE BALANCE SYNC ERROR]',
          error
        );

        /*
         * A cobrança já pertence à Stripe. Não devolvemos 500
         * por uma falha informativa para evitar retries que
         * possam pressionar o endpoint de pagamentos.
         */
        return res.status(200).json({
          received: true,
          eventType,
          balanceSync: {
            synced: false,
            reason: 'sync_failed'
          }
        });
      }
    }

    await stripeWebhook.handleStripeWebhook(
      req,
      res
    );

    if (
      eventType ===
        'payment_intent.succeeded'
    ) {
      try {
        const balanceSync =
          await syncStripeBalanceFromWebhookEvent(
            req.body
          );

        console.log(
          '[STRIPE BALANCE SYNC]',
          balanceSync
        );
      } catch (error) {
        console.error(
          '[STRIPE BALANCE SYNC ERROR]',
          error
        );
      }
    }
  }
);

export default router;
