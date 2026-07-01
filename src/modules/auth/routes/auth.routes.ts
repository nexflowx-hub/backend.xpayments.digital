import { Router } from 'express';
import { merchantLogin, merchantRegister, adminLogin } from '../controllers/auth.controller';

const router = Router();

router.post('/login', merchantLogin);
router.post('/register', merchantRegister);
router.post('/admin/login', adminLogin);

export default router;
