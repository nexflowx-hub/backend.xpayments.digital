import { Router } from 'express';
import * as directController from '../controllers/direct.controller';

const router = Router();

// ROTA SERVER-TO-SERVER (S2S)
// Exposta como /api/v1/payments/charge
// A autenticação é feita via API Key diretamente dentro do controlador
router.post('/charge', directController.processDirectCharge);

export default router;
