import { Router } from 'express';
import { getApiKeys, generateApiKey, deleteApiKey } from '../controllers/developer.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const router = Router();

router.use(authenticateMerchant); // 🔴 Escudo Ativado

router.get('/api-keys', getApiKeys);
router.post('/api-keys/generate', generateApiKey);
router.delete('/api-keys/:id', deleteApiKey);

export default router;
