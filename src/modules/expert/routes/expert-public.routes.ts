import { Router } from 'express';
import { listPublicOfferings } from '../controllers/expert-orders.controller';

const router = Router();

router.get('/offerings', listPublicOfferings);

export default router;
