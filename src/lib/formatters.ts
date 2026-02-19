export const formatCurrency = (value: number): string => {
  return value.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €';
};

export const formatCurrencyDecimal = (value: number): string => {
  return value.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
};

export const formatPercent = (value: number): string => {
  return (value * 100).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
};

export const formatNumber = (value: number, decimals = 2): string => {
  return value.toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

export const formatShares = (value: number, isBTC: boolean): string => {
  return isBTC
    ? value.toLocaleString('es-ES', { minimumFractionDigits: 5, maximumFractionDigits: 5 })
    : value.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
