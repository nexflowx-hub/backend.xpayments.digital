import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';

export const getMerchantId = (req: any): string | null => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return (jwt.verify(token, JWT_SECRET) as any).id;
  } catch (e) { return null; }
};

export const isValidUUID = (uuid: any) => typeof uuid === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid);
