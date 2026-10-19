import assert from 'node:assert/strict';
import test from 'node:test';
import { getAllowedCorsOrigins, getJwtSecret } from '../src/core/config/security';

test('JWT secret must be explicitly configured and sufficiently long', () => {
  const original = process.env.JWT_SECRET;

  try {
    delete process.env.JWT_SECRET;
    assert.throws(() => getJwtSecret(), /JWT_SECRET must be configured/);

    process.env.JWT_SECRET = 'short';
    assert.throws(() => getJwtSecret(), /JWT_SECRET must be configured/);

    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    assert.equal(getJwtSecret(), '0123456789abcdef0123456789abcdef');
  } finally {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  }
});

test('CORS allowlist is normalized from comma-separated environment configuration', () => {
  const original = process.env.XPAYMENTS_ALLOWED_ORIGINS;

  try {
    process.env.XPAYMENTS_ALLOWED_ORIGINS =
      'https://pagarpix.org, https://app.pagarpix.org, ,https://admin.xpayments.digital';

    assert.deepEqual(getAllowedCorsOrigins(), [
      'https://pagarpix.org',
      'https://app.pagarpix.org',
      'https://admin.xpayments.digital'
    ]);
  } finally {
    if (original === undefined) delete process.env.XPAYMENTS_ALLOWED_ORIGINS;
    else process.env.XPAYMENTS_ALLOWED_ORIGINS = original;
  }
});
