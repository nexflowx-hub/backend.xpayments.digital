import { Router } from 'express';
import { createSession, initiateCheckout } from '../controllers/checkout.controller';

const router = Router();
router.post('/sessions', createSession);
router.post('/initiate', initiateCheckout);
export default router;
