import { Router } from 'express';
import { getRiskProfile } from '../controllers/risk.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const router = Router();

// Middleware garante segurança absoluta
router.use(authenticateMerchant);

// GET /api/v1/risk/profile
router.get('/profile', getRiskProfile);

export default router;
