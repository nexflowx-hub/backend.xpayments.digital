import { Router } from 'express';

import {
  listPayoutStatements
} from '../controllers/payout-statements.controller';

const router = Router();

router.get(
  '/',
  listPayoutStatements
);

export default router;
