import { Router } from 'express';
import { getStores, createStore, getProducts, createProduct, updateProduct, deleteProduct, getLinks, createLink, deleteLink, getLinkByCode } from '../controllers/commerce.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const privateRouter = Router();

// 🔴 Escudo Ativado Apenas para Gestão (Lojista)
privateRouter.use(authenticateMerchant);

privateRouter.get('/:id/stores', getStores);
privateRouter.post('/:id/stores', createStore);
privateRouter.get('/products', getProducts);
privateRouter.post('/products', createProduct);
privateRouter.put('/products/:id', updateProduct);
privateRouter.delete('/products/:id', deleteProduct);
privateRouter.get('/links', getLinks);
privateRouter.post('/links', createLink);
privateRouter.delete('/links/:id', deleteLink);

export const commercePrivateRoutes = privateRouter;

const publicRouter = Router();
// O Checkout não usa o middleware porque o cliente final não tem token!
publicRouter.get('/payment-links/:urlCode', getLinkByCode);
export const commercePublicRoutes = publicRouter;
