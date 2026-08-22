import { Router } from 'express';

import * as directController from '../controllers/direct.controller';
import * as pixController from '../controllers/pix.controller';
import * as misticPayWebhook from '../controllers/misticpay.webhook';
import * as stripeWebhook from '../controllers/stripe.webhook';
import {
  syncStripeBalanceFromWebhookEvent
} from '../services/stripe-balance-sync.service';
import {
  StripeWebhookVerificationError,
  verifyStripeWebhookRequest
} from '../services/stripe-webhook-verification.service';

const router = Router();

// ==========================================
// ROTA SERVER-TO-SERVER (S2S)
// ==========================================
router.post(
  '/charge',
  (req, res) => {
    const method = String(
      req.body?.payment_method_types?.[0] ?? ''
    )
      .trim()
      .toLowerCase()
      .replace(/-/g, '_');

    /*
     * PIX segue adapter dedicado.
     *
     * Todos os demais métodos continuam
     * exatamente no controller existente.
     */
    if (method === 'pix') {
      return pixController.processPixCharge(
        req,
        res
      );
    }

    return directController.processDirectCharge(
      req,
      res
    );
  }
);

// ==========================================
// ROTA INBOUND DE PROVEDORES
// ==========================================
// A Stripe fará o POST para
// /api/v1/payments/webhooks/stripe
//
// Segurança:
// - exige corpo bruto e Stripe-Signature;
// - valida contra os webhookSecret dos Vaults stripe-* ativos;
// - associa o evento ao Gateway Vault correto antes do handler;
// - nunca usa req.body não autenticado para efeitos financeiros.
//
// Finance V4.1:
// - payment_intent.succeeded mantém o fluxo financeiro existente;
// - depois tenta persistir fee/status/available_on informativos;
// - charge.updated funciona como segunda oportunidade quando a
//   Balance Transaction ainda não estava pronta no primeiro evento;
// - esta sincronização NÃO altera wallet, status do movimento ou payout.
/*
 * PIX inbound webhook.
 *
 * O payload recebido nunca produz
 * crédito financeiro diretamente.
 * O controller confirma o estado
 * server-to-server antes do ledger.
 */
router.post(
  '/webhooks/misticpay',
  misticPayWebhook.handleMisticPayWebhook
);

router.post(
  '/webhooks/stripe',
  async (req, res) => {
    let verified;

    try {
      verified =
        await verifyStripeWebhookRequest(req);
    } catch (error) {
      if (
        error instanceof
          StripeWebhookVerificationError
      ) {
        console.warn(
          '[STRIPE WEBHOOK REJECTED]',
          {
            code: error.code,
            statusCode: error.statusCode,
            hasSignature:
              Boolean(req.get('stripe-signature')),
            rejectedAt:
              new Date().toISOString()
          }
        );

        return res
          .status(error.statusCode)
          .json({
            received: false,
            error: {
              code: error.code,
              message: error.message
            }
          });
      }

      console.error(
        '[STRIPE WEBHOOK VERIFICATION ERROR]',
        error
      );

      return res.status(500).json({
        received: false,
        error: {
          code:
            'STRIPE_WEBHOOK_VERIFICATION_FAILED',
          message:
            'Falha ao validar o webhook Stripe.'
        }
      });
    }

    req.body = verified.event;

    (req as any).verifiedStripeGatewayVaultId =
      verified.gatewayVaultId;

    (req as any).verifiedStripeProvider =
      verified.provider;

    const eventType = String(
      verified.event.type || ''
    );

    console.log(
      '[STRIPE WEBHOOK VERIFIED]',
      {
        eventId: verified.event.id,
        eventType,
        gatewayVaultId:
          verified.gatewayVaultId,
        provider: verified.provider
      }
    );

    if (eventType === 'charge.updated') {
      try {
        const balanceSync =
          await syncStripeBalanceFromWebhookEvent(
            verified.event
          );

        console.log(
          '[STRIPE BALANCE SYNC]',
          balanceSync
        );

        return res.status(200).json({
          received: true,
          eventType,
          gatewayProvider:
            verified.provider,
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
          gatewayProvider:
            verified.provider,
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
            verified.event
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
