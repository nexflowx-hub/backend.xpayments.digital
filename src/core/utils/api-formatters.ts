export const serializeResponse = (data: any): any => {
  if (data === null || data === undefined) return data;

  if (Array.isArray(data)) {
    return data.map(item => serializeResponse(item));
  }

  if (typeof data === 'object') {
    const serialized: any = {};

    for (const key in data) {
      const value = data[key];

      if (value === null || value === undefined) {
        serialized[key] = value;
      }

      // Prisma Decimal -> Number
      else if (
        typeof value === 'object' &&
        value !== null &&
        typeof value.toNumber === 'function'
      ) {
        serialized[key] = value.toNumber();
      }

      // Numeric string -> Number
      else if (
        typeof value === 'string' &&
        value.trim() !== '' &&
        !isNaN(Number(value))
      ) {
        serialized[key] = Number(value);
      }

      // Nested object
      else if (typeof value === 'object') {
        serialized[key] = serializeResponse(value);
      }

      else {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  return data;
};

export const formatWallet = (wallet: any) => ({
  ...wallet,
  balance: Number(wallet.balance || 0),
  available: Number(wallet.available || 0),
  reserved: Number(wallet.reserved || 0)
});
