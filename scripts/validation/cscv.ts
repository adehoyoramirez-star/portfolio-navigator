// ============================================================
// scripts/validation/cscv.ts
// FIX-AUDIT-PBO: CSCV REAL (Bailey, Borwein, López de Prado & Zhu).
//
// El "PBO" anterior barajaba índices de UNA sola serie de retornos y
// remuestreaba IS/OOS con reemplazo (`dsr_pbo.ts`). Sin matriz
// configuraciones × tiempo eso no mide sobreajuste de SELECCIÓN: mide ruido
// de bootstrap sobre la misma serie. Aquí se implementa CSCV de verdad:
//   · se parte el tiempo en S bloques contiguos,
//   · se enumeran TODAS las particiones IS/OOS de S/2 bloques,
//   · en IS se elige la configuración con mayor Sharpe,
//   · en OOS se mira el RANGO de esa configuración elegida,
//   · PBO = fracción de particiones en que la ganadora IS queda por debajo
//     de la mediana OOS (logit λ ≤ 0).
// Entrada obligatoria: matrix[t][c] = retorno del día t para la config c.
// ============================================================

export const DAYS_PER_YEAR = 252;

export function sharpeOf(xs: number[], rfAnnual = 0.04): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, r) => s + (r - m) ** 2, 0) / xs.length);
  return sd > 0 ? (m * DAYS_PER_YEAR - rfAnnual) / (sd * Math.sqrt(DAYS_PER_YEAR)) : 0;
}

/** Todas las combinaciones de k índices sobre 0..s-1. */
function combinations(s: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const walk = (start: number) => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i < s; i++) { cur.push(i); walk(i + 1); cur.pop(); }
  };
  walk(0);
  return out;
}

export interface CscvResult {
  pbo: number;
  logits: number[];
  partitions: number;
  configs: number;
  observations: number;
  blocks: number;
  /** Sharpe IS/OOS medios por configuración (diagnóstico de estabilidad). */
  meanIsSharpe: number[];
  meanOosSharpe: number[];
}

export function cscvPbo(matrix: number[][], blocks = 12, rfAnnual = 0.04): CscvResult {
  const T = matrix.length;
  const N = matrix[0]?.length ?? 0;
  if (N < 2) throw new Error('CSCV requiere al menos 2 configuraciones');
  if (T < blocks * 2) throw new Error(`CSCV requiere al menos ${blocks * 2} observaciones`);
  const S = blocks % 2 === 0 ? blocks : blocks - 1;
  const blockSize = Math.floor(T / S);

  // Índices de tiempo por bloque contiguo (los restos van al último bloque).
  const blockIdx: number[][] = [];
  for (let b = 0; b < S; b++) {
    const from = b * blockSize;
    const to = b === S - 1 ? T : from + blockSize;
    const idx: number[] = [];
    for (let i = from; i < to; i++) idx.push(i);
    blockIdx.push(idx);
  }

  const half = S / 2;
  const combos = combinations(S, half);
  const logits: number[] = [];
  const isSum = new Array(N).fill(0);
  const oosSum = new Array(N).fill(0);

  for (const isBlocks of combos) {
    const isSet = new Set(isBlocks);
    const isIdx: number[] = [];
    const oosIdx: number[] = [];
    for (let b = 0; b < S; b++) (isSet.has(b) ? isIdx : oosIdx).push(...blockIdx[b]);

    let bestC = 0;
    let bestS = -Infinity;
    const oosSharpe = new Array(N).fill(0);
    for (let c = 0; c < N; c++) {
      const sIs = sharpeOf(isIdx.map(t => matrix[t][c]), rfAnnual);
      isSum[c] += sIs;
      if (sIs > bestS) { bestS = sIs; bestC = c; }
      oosSharpe[c] = sharpeOf(oosIdx.map(t => matrix[t][c]), rfAnnual);
      oosSum[c] += oosSharpe[c];
    }

    // Rango OOS de la ganadora IS (0 = peor, N-1 = mejor).
    const sorted = [...oosSharpe].sort((a, b) => a - b);
    const bestOosValue = oosSharpe[bestC];
    let rank = 0;
    for (let i = 0; i < N; i++) if (sorted[i] < bestOosValue) rank++;
    const omega = (rank + 1) / (N + 1);
    logits.push(Math.log(omega / (1 - omega)));
  }

  const pbo = logits.filter(l => l <= 0).length / logits.length;
  return {
    pbo,
    logits,
    partitions: logits.length,
    configs: N,
    observations: T,
    blocks: S,
    meanIsSharpe: isSum.map(v => v / combos.length),
    meanOosSharpe: oosSum.map(v => v / combos.length),
  };
}
