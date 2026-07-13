import { Router } from 'express';
import * as checkoutController from '../controllers/checkout.controller';

const router = Router();

// 1. S2S: Criação da intenção de checkout pelo servidor do Lojista (Autenticado via API Key no controller)
router.post('/sessions', checkoutController.createSession);

// 2. PÚBLICO: O Frontend de Checkout carrega os dados para mostrar ao cliente final
router.get('/sessions/:sessionId', checkoutController.loadSession);

// O processamento real do pagamento pelo frontend viria depois para uma rota POST /sessions/:sessionId/pay
// Que reutilizaria o motor do direct.controller.ts internamente.

export default router;
