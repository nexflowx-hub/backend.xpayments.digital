import { Router } from 'express';

import * as ctrl from '../controllers/developer.controller';
import * as secretCtrl from '../controllers/developer-secrets.controller';

const router = Router();

router.get('/api-keys', ctrl.getApiKeys);
router.post('/api-keys', ctrl.createApiKey);
router.post('/api-keys/:id/reveal', secretCtrl.revealApiKey);
router.post('/api-keys/:id/rotate', secretCtrl.rotateApiKey);
router.delete('/api-keys/:id', ctrl.deleteApiKey);

router.get('/webhooks', ctrl.getWebhooks);
router.post('/webhooks', ctrl.createWebhook);
router.post('/webhooks/:id/reveal', secretCtrl.revealWebhookSecret);
router.post('/webhooks/:id/rotate-secret', secretCtrl.rotateWebhookSecret);
router.put('/webhooks/:id', ctrl.updateWebhook);
router.patch('/webhooks/:id', ctrl.updateWebhook);
router.delete('/webhooks/:id', ctrl.deleteWebhook);

export default router;
