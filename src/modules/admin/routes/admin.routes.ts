import { Router } from 'express';
import { getGateways, updateGateway, getPlatformStats } from '../controllers/admin.controller';
import { authenticateAdmin } from '../../../middleware/admin.middleware';

const router = Router();

// 🔴 Escudo Ativado: Lojistas normais levam Erro 403 aqui.
router.use(authenticateAdmin);

router.get('/gateways', getGateways);
router.put('/gateways/:providerId', updateGateway);
router.get('/stats', getPlatformStats);

export default router;
