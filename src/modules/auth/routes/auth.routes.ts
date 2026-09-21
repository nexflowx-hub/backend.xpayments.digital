import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { registerPagarPix } from '../controllers/pagarpix-onboarding.controller';
import { authMiddleware } from '../../../middleware/auth.middleware';

const router = Router();
router.post('/login', ctrl.login);
router.post('/register', ctrl.register);
router.post('/pagarpix/register', registerPagarPix);
router.post('/logout', ctrl.logout);
router.get('/me', authMiddleware, ctrl.me);

export default router;
