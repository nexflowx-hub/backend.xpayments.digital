const stringOr = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
};

const numberOr = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const isoOrNow = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  return new Date(0).toISOString();
};

export const formatMerchantSession = (merchant: any, token?: string) => ({
  id: stringOr(merchant?.id),
  merchantId: stringOr(merchant?.id),
  name: stringOr(merchant?.name, 'XPayments Merchant'),
  email: stringOr(merchant?.email),
  company: stringOr(merchant?.company, merchant?.name || 'XPayments Merchant'),
  tier: stringOr(merchant?.tier, 'TIER_C_STANDARD'),
  status: stringOr(merchant?.status, 'active'),
  kycStatus: stringOr(merchant?.kycStatus, 'not_submitted'),
  riskScore: numberOr(merchant?.riskScore),
  role: stringOr(merchant?.role, 'merchant'),
  createdAt: isoOrNow(merchant?.createdAt),
  updatedAt: isoOrNow(merchant?.updatedAt),
  ...(token ? { token, accessToken: token } : {})
});

export const formatWallet = (wallet: any) => ({
  id: stringOr(wallet?.id),
  merchantId: stringOr(wallet?.merchantId),
  currency: stringOr(wallet?.currency, 'EUR'),
  label: stringOr(wallet?.label, `${stringOr(wallet?.currency, 'EUR')} Wallet`),
  balance: numberOr(wallet?.balance),
  available: numberOr(wallet?.available, numberOr(wallet?.balance)),
  reserved: numberOr(wallet?.reserved),
  type: stringOr(wallet?.type, 'fiat'),
  cardLast4: stringOr(wallet?.cardLast4),
  createdAt: isoOrNow(wallet?.createdAt)
});

export const formatTransaction = (transaction: any) => ({
  id: stringOr(transaction?.id),
  merchantId: stringOr(transaction?.merchantId),
  reference: stringOr(transaction?.reference, stringOr(transaction?.id, 'TX-UNKNOWN')),
  customer: stringOr(transaction?.customer, 'Guest customer'),
  customerEmail: stringOr(transaction?.customerEmail, 'guest@xpayments.digital'),
  amount: numberOr(transaction?.amount),
  currency: stringOr(transaction?.currency, 'EUR'),
  amountEur: numberOr(transaction?.amountEur, numberOr(transaction?.amount)),
  status: stringOr(transaction?.status, 'pending'),
  method: stringOr(transaction?.method, 'card'),
  country: stringOr(transaction?.country, 'N/A'),
  gateway: stringOr(transaction?.gateway, 'xpayments'),
  riskScore: numberOr(transaction?.riskScore),
  fee: numberOr(transaction?.fee),
  metadata: transaction?.metadata ?? {},
  createdAt: isoOrNow(transaction?.createdAt)
});

export const formatProduct = (product: any) => ({
  id: stringOr(product?.id),
  merchantId: stringOr(product?.merchantId),
  name: stringOr(product?.name, 'Untitled product'),
  description: stringOr(product?.description),
  price: numberOr(product?.price),
  currency: stringOr(product?.currency, 'EUR'),
  active: Boolean(product?.active ?? true),
  sales: numberOr(product?.sales),
  stock: product?.stock === null || product?.stock === undefined ? null : numberOr(product.stock),
  createdAt: isoOrNow(product?.createdAt)
});

export const formatStore = (store: any) => ({
  id: stringOr(store?.id),
  merchantId: stringOr(store?.merchantId),
  name: stringOr(store?.name, 'Untitled store'),
  domain: stringOr(store?.domain),
  status: stringOr(store?.status, 'draft'),
  revenue: numberOr(store?.revenue),
  currency: stringOr(store?.currency, 'EUR'),
  createdAt: isoOrNow(store?.createdAt)
});
