import { Router } from 'express';
import * as ctrl from '../controllers/routing.controller';

const router = Router();

router.get('/connections', (ctrl as any).getConnections);
router.get('/policies', (ctrl as any).getPolicies);
router.put('/policies', (ctrl as any).putPolicy);
router.get('/decisions', (ctrl as any).getDecisions);

export default router;
