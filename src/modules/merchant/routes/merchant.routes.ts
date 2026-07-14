import { Router } from 'express';
import * as merchant from '../controllers/merchant.controller';

const router = Router();

router.get('/profile', merchant.getProfile);

router.get('/stores', merchant.getStores);

router.get('/stores/:id', merchant.getStore);

export default router;
