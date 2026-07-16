import { Router } from 'express';

import {
  chat,
  status
} from '../controllers/ai.controller';

const router = Router();

router.get('/status', status);
router.post('/chat', chat);

export default router;
