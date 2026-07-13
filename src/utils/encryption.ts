import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

const getMasterKey = () => {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  if (!key || key.length !== 64) {
    throw new Error('A variável ENCRYPTION_MASTER_KEY deve ter exatamente 64 caracteres hexadecimais (32 bytes).');
  }
  return Buffer.from(key, 'hex');
};

export function encryptData(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getMasterKey(), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

export function decryptData(encryptedString: string): string {
  const parts = encryptedString.split(':');
  if (parts.length !== 3) throw new Error('Formato de dados encriptados inválido.');

  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  const authTag = Buffer.from(parts[2], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, getMasterKey(), iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
