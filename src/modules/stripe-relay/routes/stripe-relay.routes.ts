import { Router } from 'express';
import { stripeRelay } from '../controllers/stripe-relay.controller';

const router = Router();

router.post('/payment_intents', stripeRelay);
router.get('/payment_intents/:id', stripeRelay);
router.post('/payment_intents/:id', stripeRelay);
router.post('/payment_intents/:id/confirm', stripeRelay);
router.post('/payment_intents/:id/cancel', stripeRelay);
router.post('/payment_intents/:id/capture', stripeRelay);

export default router;
