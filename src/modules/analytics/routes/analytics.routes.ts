import { Router } from 'express';
import { getDashboardAnalytics } from '../controllers/analytics.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const router = Router();

// Middleware garante que só o próprio Lojista lê os seus gráficos
router.use(authenticateMerchant);

router.get('/overview', getDashboardAnalytics);

export default router;
