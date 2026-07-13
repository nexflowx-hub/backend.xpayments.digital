import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
export const getApiKeys = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const createApiKey = async (req: AuthRequest, res: Response) => res.json({ success: true, data: { fullKey: 'sk_test_123' } });
export const deleteApiKey = async (req: AuthRequest, res: Response) => res.json({ success: true });

export const getWebhooks = async (req: AuthRequest, res: Response) => res.json({ success: true, data: [] });
export const createWebhook = async (req: AuthRequest, res: Response) => res.json({ success: true, data: {} });
export const deleteWebhook = async (req: AuthRequest, res: Response) => res.json({ success: true });
