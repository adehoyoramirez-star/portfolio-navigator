// src/lib/macroExtended.ts

/**
 * Representa los datos macroeconómicos que el usuario puede editar manualmente.
 * - erp: PER del S&P 500 (Price-to-Earnings ratio). Se usa para calcular el ERP en la UI.
 * - m2Growth: crecimiento interanual de la oferta monetaria M2 (en porcentaje).
 */
export interface MacroExtendedData {
  erp: number;
  m2Growth: number;
}

/**
 * Valores por defecto para los datos macro.
 * - erp: 22 (PER promedio histórico reciente)
 * - m2Growth: 5.2% (crecimiento típico de M2)
 */
export const DEFAULT_MACRO: MacroExtendedData = {
  erp: 22,
  m2Growth: 5.2
};