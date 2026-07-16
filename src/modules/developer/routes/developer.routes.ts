import { Router } from 'express';

import * as ctrl from '../controllers/developer.controller';

const router = Router();

router.get('/api-keys', ctrl.getApiKeys);
router.post('/api-keys', ctrl.createApiKey);
router.delete('/api-keys/:id', ctrl.deleteApiKey);

router.get('/webhooks', ctrl.getWebhooks);
router.post('/webhooks', ctrl.createWebhook);
router.put('/webhooks/:id', ctrl.updateWebhook);
router.patch('/webhooks/:id', ctrl.updateWebhook);
router.delete('/webhooks/:id', ctrl.deleteWebhook);

export default router;
