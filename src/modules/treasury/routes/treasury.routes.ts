import { Router } from 'express';
import { getTreasuryOverview } from '../controllers/treasury.controller';

const router = Router();

// Endpoint correspondente a GET /api/v1/treasury/overview
router.get('/overview', getTreasuryOverview);

export default router;
