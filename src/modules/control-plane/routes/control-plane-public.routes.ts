import { Router } from 'express';
import { loginControlPlane } from '../controllers/control-plane-auth.controller';

const router = Router();

router.post('/auth/login', loginControlPlane);

export default router;
