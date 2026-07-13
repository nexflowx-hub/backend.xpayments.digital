import { Router } from 'express';
import * as directController from '../controllers/direct.controller';
import * as stripeWebhook from '../controllers/stripe.webhook';

const router = Router();

// ==========================================
// ROTA SERVER-TO-SERVER (S2S)
// ==========================================
router.post('/charge', directController.processDirectCharge);

// ==========================================
// ROTA INBOUND DE PROVEDORES (Webhooks globais)
// ==========================================
// A Stripe fará o POST para /api/v1/payments/webhooks/stripe
router.post('/webhooks/stripe', stripeWebhook.handleStripeWebhook);

export default router;
