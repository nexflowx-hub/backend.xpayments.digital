import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import * as recoveryCtrl from '../controllers/password-recovery.controller';
import { authMiddleware } from '../../../middleware/auth.middleware';

const router = Router();
router.post('/login', ctrl.login);
router.post('/register', ctrl.register);
router.post('/forgot', recoveryCtrl.forgotPassword);
router.post('/reset', recoveryCtrl.resetPassword);
router.post('/logout', ctrl.logout);
router.get('/me', authMiddleware, ctrl.me);

export default router;
