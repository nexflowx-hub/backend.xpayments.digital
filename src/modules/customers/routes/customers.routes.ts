import { Router } from 'express';
import { getCustomers } from '../controllers/customers.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const router = Router();

// Rota protegida: Devolve a lista de clientes com o LTV e estatísticas avançadas
router.get('/', authenticateMerchant, getCustomers);

export default router;
