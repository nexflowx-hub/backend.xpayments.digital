import { Router } from 'express';
import * as ctrl from '../controllers/risk.controller';
const router = Router();
router.get('/profile', (ctrl as any).getProfile);
router.get('/kyc/status', (ctrl as any).getKycStatus);
export default router;
