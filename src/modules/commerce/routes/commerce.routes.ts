import { Router } from 'express';

import * as ctrl from '../controllers/commerce.controller';
import { getCustomersV2 } from '../controllers/customer-readmodel.controller';

const router = Router();

router.get('/transactions', ctrl.getTransactions);

router.get('/stores', ctrl.getStores);

router.get('/products', ctrl.getProducts);
router.post('/products', ctrl.createProduct);
router.delete('/products/:id', ctrl.deleteProduct);

router.get('/customers', getCustomersV2);

router.get('/payment-links', ctrl.getPaymentLinks);
router.get('/invoices', ctrl.getInvoices);
router.get('/subscriptions', ctrl.getSubscriptions);

export default router;
