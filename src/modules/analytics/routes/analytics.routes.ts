import { Router } from 'express';
import * as ctrl from '../controllers/analytics.controller';
const router = Router();
router.get('/overview', (ctrl as any).getOverview);
export default router;
