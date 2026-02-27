// src/lib/formatters.ts
export const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
};

export const formatPercentage = (value: number): string => {
  return new Intl.NumberFormat('es-ES', { style: 'percent', minimumFractionDigits: 1 }).format(value);
};