import { Router } from 'express';
import { getCustomers, getCustomerById } from '../controllers/customers.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const router = Router();

// 🔴 O MIDDLEWARE É INJETADO AQUI. Ninguém passa sem Token válido.
router.use(authenticateMerchant);

router.get('/', getCustomers);
router.get('/:id', getCustomerById);

export default router;
