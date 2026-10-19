const MIN_JWT_SECRET_LENGTH = 32;

export const getJwtSecret = (): string => {
  const secret = String(process.env.JWT_SECRET ?? '').trim();

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be configured with at least ${MIN_JWT_SECRET_LENGTH} characters.`
    );
  }

  return secret;
};

export const getAllowedCorsOrigins = (): string[] =>
  String(process.env.XPAYMENTS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
