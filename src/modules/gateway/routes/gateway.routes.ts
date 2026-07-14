import { Router } from 'express';
import * as ctrl from '../controllers/gateway.controller';

const router = Router();

router.get('/', ctrl.listGateways);
router.get('/:id', ctrl.getGateway);

router.post('/', ctrl.createGateway);

router.patch('/:id', ctrl.updateGateway);

router.delete('/:id', ctrl.deleteGateway);

export default router;
