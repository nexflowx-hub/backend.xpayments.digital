import { Router } from 'express';
import { createSession, loadSession, initiatePayment } from '../controllers/checkout.controller';

const router = Router();

router.post('/session', createSession);
router.get('/session/:sessionId', loadSession);
router.post('/initiate', initiatePayment);

export default router;
