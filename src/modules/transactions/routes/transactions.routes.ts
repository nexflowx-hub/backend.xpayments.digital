import { Router } from 'express';
import * as ctrl from '../controllers/transactions.controller';
import { authMiddleware } from '../../../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/', ctrl.listTransactions);

router.get('/stats', ctrl.getTransactionStats);

router.get('/:id', ctrl.getTransaction);

export default router;
