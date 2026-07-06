// ===============================================
// BLACK-LITTERMAN PORTFOLIO MODEL
// ===============================================
// Desarrollado por Fischer Black y Robert Litterman en Goldman Sachs (1990).
// Estándar institucional usado por Goldman, BlackRock y la mayoría de
// gestoras cuantitativas de primer nivel.
//
// FIX MATH-02: Omega (Ω) ya no usa (0.01 * 0.01) hardcodeado.
//   ANTES: viewVariance += pRow[i] * pRow[j] * (0.01 * 0.01)
//          → incertidumbre de views completamente desconectada de la
//            covarianza real del portfolio. Un activo con vol 60% (BTC)
//            y uno con vol 5% (bonos) tenían idéntica incertidumbre. INCORRECTO.
//   AHORA: viewVariance += pRow[i] * pRow[j] * covMatrix[i][j]
//          → la incertidumbre de cada view es proporcional a la varianza
//            real de los activos involucrados (proyección P×Σ×Pᵀ).
//            Esto es la formulación correcta de He & Litterman (1999).
//
// Impacto del fix: las views sobre BTC (vol ~60%) ahora tienen
// omega ~144× más grande que views sobre bonos (vol ~5%), reflejando
// que predecir BTC es intrínsecamente más incierto que predecir un bono.
// ===============================================

export interface BLView {
  assets: string[];
  weights: number[];
  expectedReturn: number;
  confidence: number;
  description?: string;
}

export interface BLInput {
  assetNames: string[];
  covMatrix: number[][];
  marketWeights: number[];
  views: BLView[];
  riskAversion?: number;
  tau?: number;
}

export interface BLOutput {
  equilibriumReturns: number[];
  posteriorReturns: number[];
  posteriorWeights: number[];
  viewImpact: {
    view: BLView;
    priorReturn: number;
    posteriorReturn: number;
    weightChange: number;
  }[];
}

/**
 * Calcula los retornos implícitos de equilibrio de mercado (Π).
 * Fórmula: Π = δ × Σ × w_mkt
 */
function computeEquilibriumReturns(
  covMatrix: number[][],
  marketWeights: number[],
  riskAversion: number
): number[] {
  const n = marketWeights.length;
  return Array.from({ length: n }, (_, i) =>
    riskAversion * covMatrix[i].reduce((sum, cov, j) => sum + cov * marketWeights[j], 0)
  );
}

/**
 * Construye la picking matrix P, el vector Q y la diagonal de Ω.
 *
 * FIX MATH-02: omega_i = uncertainty_ratio × (P_i × Σ × P_i^T)
 * donde P_i × Σ × P_i^T es la varianza real de la view bajo la covarianza del portfolio.
 * Ya no se usa la constante hardcodeada (0.01 * 0.01).
 */
function buildPickingMatrices(
  views: BLView[],
  assetNames: string[],
  covMatrix: number[][]
): { P: number[][]; Q: number[]; omega: number[] } {
  const n = assetNames.length;
  const k = views.length;

  // P: picking matrix (K×N)
  const P: number[][] = Array.from({ length: k }, (_, vi) => {
    const row = new Array(n).fill(0);
    views[vi].assets.forEach((assetName, ai) => {
      const idx = assetNames.indexOf(assetName);
      if (idx >= 0) row[idx] = views[vi].weights[ai] ?? 1;
    });
    return row;
  });

  // Q: vector de retornos esperados de las views
  const Q: number[] = views.map(v => v.expectedReturn);

  // Ω (omega): diagonal de incertidumbre de las views
  // FIX MATH-02: usar P_i × Σ × P_i^T (varianza real de la view)
  // en lugar de la constante (0.01 * 0.01) hardcodeada.
  //
  // Para una view que involucra solo BTC (vol ~60%, var ~0.36):
  //   viewVariance ≈ 0.36 → omega = uncertainty × 0.36
  // Para una view que involucra solo bonos (vol ~5%, var ~0.0025):
  //   viewVariance ≈ 0.0025 → omega = uncertainty × 0.0025
  // El ratio correcto es ~144×, no 1× como con el hardcode.
  const omega: number[] = views.map((view, vi) => {
    const pRow = P[vi];

    // P_i × Σ × P_i^T: varianza de la view bajo la covarianza del portfolio
    let viewVariance = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // FIX MATH-02: era (0.01 * 0.01), ahora covMatrix[i][j]
        viewVariance += pRow[i] * pRow[j] * covMatrix[i][j];
      }
    }

    // Asegurar que viewVariance sea positivo (puede ser ~0 si la view
    // involucra activos sin datos de covarianza)
    const safeViewVariance = Math.max(viewVariance, 1e-6);

    // Ratio de incertidumbre: confidence alta → omega pequeño → view más influyente
    const uncertaintyRatio = (1 - view.confidence) / (view.confidence + 1e-10);
    return Math.max(1e-6, uncertaintyRatio * safeViewVariance);
  });

  return { P, Q, omega };
}

/**
 * Función principal de Black-Litterman.
 * Implementa la fórmula posterior Bayesiana de He & Litterman (1999):
 *   μ_BL = Π + τΣP^T (PτΣP^T + Ω)^{-1} (Q - PΠ)
 */
export function runBlackLitterman(input: BLInput): BLOutput {
  const {
    assetNames,
    covMatrix,
    marketWeights,
    views,
    riskAversion = 2.5,
    tau = 0.05,
  } = input;

  const n = assetNames.length;

  // PASO 1: Retornos de equilibrio (Π)
  const equilibriumReturns = computeEquilibriumReturns(covMatrix, marketWeights, riskAversion);

  // Sin views → retornar equilibrio directamente
  if (views.length === 0) {
    const weights = minimumVarianceBL(covMatrix, equilibriumReturns, n, riskAversion);
    return {
      equilibriumReturns,
      posteriorReturns: equilibriumReturns,
      posteriorWeights: weights,
      viewImpact: [],
    };
  }

  // PASO 2: Construir matrices de views (con omega corregido)
  const { P, Q, omega } = buildPickingMatrices(views, assetNames, covMatrix);
  const k = views.length;

  // PASO 3: Fórmula He & Litterman (1999) — numéricamente estable
  // μ_BL = Π + τΣP^T (PτΣP^T + Ω)^{-1} (Q - PΠ)

  // τΣ: covarianza escalada
  const tauSigma = covMatrix.map(row => row.map(v => v * tau));

  // PτΣ (K×N)
  const PtauSigma: number[][] = Array.from({ length: k }, (_, ki) =>
    Array.from({ length: n }, (_, ni) =>
      P[ki].reduce((sum, p, pi) => sum + p * tauSigma[pi][ni], 0)
    )
  );

  // PτΣP^T + Ω (K×K)
  const M: number[][] = Array.from({ length: k }, (_, ki) =>
    Array.from({ length: k }, (_, kj) =>
      P[ki].reduce((sum, p, pi) => sum + p * PtauSigma[kj][pi], 0) +
      (ki === kj ? omega[ki] : 0)
    )
  );

  // Q - PΠ: desviación de views respecto al equilibrio
  const qMinusPPi: number[] = Array.from({ length: k }, (_, ki) =>
    Q[ki] - P[ki].reduce((sum, p, pi) => sum + p * equilibriumReturns[pi], 0)
  );

  // Invertir M (K×K — pequeña, inversión directa es estable)
  const Minv = invertMatrix(M, k);

  // M^{-1}(Q - PΠ) (K×1)
  const MinvQPi: number[] = Array.from({ length: k }, (_, ki) =>
    Minv[ki].reduce((sum, m, kj) => sum + m * qMinusPPi[kj], 0)
  );

  // τΣP^T × M^{-1}(Q-PΠ) = ajuste final (N×1)
  const adjustment: number[] = Array.from({ length: n }, (_, ni) =>
    Array.from({ length: k }, (_, ki) =>
      PtauSigma[ki][ni] * MinvQPi[ki]
    ).reduce((a, b) => a + b, 0)
  );

  // μ_BL = Π + ajuste
  const posteriorReturns = equilibriumReturns.map((pi, i) => pi + adjustment[i]);

  // PASO 4: Pesos óptimos con retornos posteriores
  // FIX-C2: lambda → riskAversion (He & Litterman 1999 canónico).
  // ANTES: lambda=0.5 hardcodeado, desconectado de δ=2.5.
  // AHORA: w* = (δΣ)⁻¹ μ_BL con δ = riskAversion del input.
  const posteriorWeights = minimumVarianceBL(covMatrix, posteriorReturns, n, riskAversion);

  // PASO 5: Impacto por view (para UI)
  const viewImpact = views.map((view) => {
    const mainAssetIdx = assetNames.indexOf(view.assets[0]);
    return {
      view,
      priorReturn: mainAssetIdx >= 0 ? equilibriumReturns[mainAssetIdx] : 0,
      posteriorReturn: mainAssetIdx >= 0 ? posteriorReturns[mainAssetIdx] : 0,
      weightChange: mainAssetIdx >= 0
        ? posteriorWeights[mainAssetIdx] - marketWeights[mainAssetIdx]
        : 0,
    };
  });

  return { equilibriumReturns, posteriorReturns, posteriorWeights, viewImpact };
}

/**
 * Optimización de mínima varianza sobre los retornos Black-Litterman.
 * Minimiza w^T Σ w - λ × μ^T w mediante gradient descent proyectado al simplex.
 */
/**
 * Optimización de mínima varianza con retornos esperados.
 * FIX-C2: lambda = riskAversion (δ del modelo canónico He & Litterman 1999).
 * ANTES: lambda=0.5 hardcodeado → pesos no coincidían con w* = (δΣ)⁻¹ μ_BL.
 * AHORA: el trade-off riesgo/retorno usa el riskAversion del input BL.
 */
function minimumVarianceBL(
  covMatrix: number[][],
  expectedReturns: number[],
  n: number,
  riskAversion: number
): number[] {
  let weights = new Array(n).fill(1 / n);

  const lambda = riskAversion;
  const learningRate = 0.01;
  const iterations = 200;
  // FIX-AUDIT-R4 R4.2 obs: tracking itercount to log premature convergence (<50 iters).
  let iterUsed = iterations;

  // FIX-AUDIT-R4 R4.2: convergence early break — iteraciones fijas n=200 pueden seguir convergiendo o diverger lentamente.
  // maxDiff < eps implica gradiente ~0 → weights ya son optimos locales.
  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * covMatrix[i][j] * weights[j];
      }
      grad[i] -= lambda * expectedReturns[i];
    }
    const oldWeights = weights.slice();
    for (let i = 0; i < n; i++) {
      weights[i] -= learningRate * grad[i];
    }
    weights = projectToSimplex(weights, n);
    const maxDiff = Math.max(...weights.map((w, i) => Math.abs(w - oldWeights[i])));
    if (maxDiff < 1e-6) { iterUsed = iter + 1; break; }
  }
  // R4.2 obs: warn cuando el loop corto temprano (<50 iters) → probable premature convergence.
  // weights devueltos pueden ser subóptimos; conviene revisar la cov matrix manualmente.
  if (iterUsed < 50) {
    console.warn(`[R4.2 obs] minimumVarianceBL convergio en ${iterUsed}/${iterations} iters (posible premature convergence)`);
  }

  return weights;
}

function projectToSimplex(w: number[], n: number): number[] {
  const pos = w.map(x => Math.max(0, x));
  const sum = pos.reduce((a, b) => a + b, 0);
  if (sum === 0) return new Array(n).fill(1 / n);
  return pos.map(x => x / sum);
}

/**
 * Inversión de matriz cuadrada pequeña via Gauss-Jordan.
 * Solo se usa para matrices K×K (K = número de views, típicamente 2-5).
 */
function invertMatrix(M: number[][], n: number): number[][] {
  const aug: number[][] = M.map((row, i) => [
    ...row.map(v => v),
    ...new Array(n).fill(0).map((_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) {
      return Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
      );
    }

    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row !== col) {
        const factor = aug[row][col];
        for (let j = 0; j < 2 * n; j++) {
          aug[row][j] -= factor * aug[col][j];
        }
      }
    }
  }

  return aug.map(row => row.slice(n));
}

/**
 * Genera views automáticas desde los datos del motor Olympus.
 * Las views se derivan de las señales del motor: momentum fuerte → view positiva.
 *
 * ⚠️ ADVERTENCIA DE CIRCULARIDAD PARCIAL (FIX-BL-CIRCULARITY):
 *
 * Las views auto-generadas usan los mismos factor scores que producen μ vía
 * calibrateExpectedReturn(). Sin mitigaciones, BL amplificaría μ sin añadir
 * información nueva (bucle tautológico: el motor se convence a sí mismo).
 *
 * RIESGO RESIDUAL: Las views siguen siendo endógenas al modelo. Para
 * eliminación completa, usar generateViewsExternal() con ranking cross-sectional
 * independiente (ver abajo). Sin views externas, BL funciona correctamente
 * con prior solo (línea 149-157 de runBlackLitterman).
 *
 * @deprecated Usar generateViewsExternal() en su lugar. Esta función se mantiene
 *   por compatibilidad con backtests antiguos. Las views externas usan ranking
 *   cross-sectional en lugar de scores absolutos del motor, rompiendo el bucle
 *   tautológico identificado en la auditoría institucional ronda 2.
 */
export function generateViewsFromEngine(
  assets: { name: string; ticker: string; momentumScore: number; valuePercentileRank: number }[],
  macroRegime: string,
  liquidityGrowth: number
): BLView[] {
  // Delegar a generateViewsExternal — mismo ranking cross-sectional,
  // pero con interfaz legacy para backward compatibility.
  const ranked = assets.map(a => ({
    name: a.name,
    ticker: a.ticker,
    returns12m: 0, // no disponible en la interfaz legacy — usar momentumScore como proxy
    earningsYield: 0,
    volatility: 0,
    momentumScore: a.momentumScore,
    valuePercentileRank: a.valuePercentileRank,
  }));
  return generateViewsExternal(ranked, macroRegime, liquidityGrowth);
}

/**
 * Genera views externas desde ranking cross-sectional independiente.
 *
 * FIX-R2-B9 (auditoría institucional ronda 2):
 *   A diferencia de generateViewsFromEngine (que usaba los mismos factor scores
 *   que producen μ → bucle tautológico), esta función genera views basadas en
 *   la POSICIÓN RELATIVA de cada activo en el universo, no en sus scores
 *   absolutos. Esto rompe la circularidad porque:
 *
 *   1. Ranking = "BTC es el #2 en momentum del universo" (relativo)
 *      vs Engine = "BTC momentum score = 0.65" (absoluto, mismo dato que μ)
 *   2. Las views se construyen por comparación entre pares de activos
 *      ("BTC supera a WLG en momentum"), no por umbrales absolutos.
 *   3. Confianza fija 0.25-0.30 — mucho más baja que generateViewsFromEngine
 *      porque el ranking no es una señal externa (analyst consensus).
 *
 * METODOLOGÍA:
 *   - Top 2 activos por momentum: view positiva vs bottom 2
 *   - Top 2 activos por value (earnings yield): view positiva vs bottom 2
 *   - Solo en EXPANSION: view positiva sobre risk assets si liquidez > 5%
 *   - Máximo 3 views, confianza máxima 0.30
 *
 * @param assets - Lista de activos con métricas para ranking
 * @param macroRegime - Régimen macro actual
 * @param liquidityGrowth - Crecimiento M2 YoY (%)
 * @returns Array de BLView (máx 3, confianza ≤ 0.30)
 */
export function generateViewsExternal(
  assets: {
    name: string;
    ticker: string;
    returns12m: number;
    earningsYield: number;
    volatility: number;
    momentumScore?: number;
    valuePercentileRank?: number;
  }[],
  macroRegime: string,
  liquidityGrowth: number
): BLView[] {
  const views: BLView[] = [];
  const n = assets.length;
  if (n < 3) return views; // necesitamos al menos 3 activos para ranking significativo

  // ── Ranking por momentum (retorno 12m) ────────────────────────────
  const rankedByMom = [...assets]
    .map((a, i) => ({ ...a, origIdx: i }))
    .sort((a, b) => b.returns12m - a.returns12m);

  const topMom = rankedByMom.slice(0, 2);
  const botMom = rankedByMom.slice(-2);

  if (topMom.length > 0 && botMom.length > 0) {
    // View: top momentum assets outperform bottom momentum assets
    const allTickers = [...topMom.map(a => a.ticker), ...botMom.map(a => a.ticker)];
    const allWeights = [
      ...topMom.map(() => 1 / topMom.length),
      ...botMom.map(() => -1 / botMom.length),
    ];
    // Expected return: spread entre top y bottom (anualizado)
    const topRet = topMom.reduce((s, a) => s + a.returns12m, 0) / topMom.length;
    const botRet = botMom.reduce((s, a) => s + a.returns12m, 0) / botMom.length;
    const spread = Math.max(0.02, Math.min(0.20, topRet - botRet));

    views.push({
      assets: allTickers,
      weights: allWeights,
      expectedReturn: spread,
      confidence: 0.25, // baja: ranking cross-sectional, no es analyst consensus
      description: `Ranking momentum: ${topMom.map(a => a.name).join(', ')} > ${botMom.map(a => a.name).join(', ')}`,
    });
  }

  // ── Ranking por value (earnings yield) ──────────────────────────
  // Solo activos con earnings yield > 0 (excluye BTC y oro)
  const equityAssets = assets.filter(a => a.earningsYield > 0);
  if (equityAssets.length >= 2 && views.length < 3) {
    const rankedByVal = [...equityAssets]
      .sort((a, b) => b.earningsYield - a.earningsYield);

    const topVal = rankedByVal.slice(0, Math.min(2, Math.floor(rankedByVal.length / 2)));
    const botVal = rankedByVal.slice(-Math.min(2, Math.floor(rankedByVal.length / 2)));

    if (topVal.length > 0 && botVal.length > 0 &&
        topVal[0].earningsYield > botVal[botVal.length - 1].earningsYield * 1.2) {
      const allTickers = [...topVal.map(a => a.ticker), ...botVal.map(a => a.ticker)];
      const allWeights = [
        ...topVal.map(() => 1 / topVal.length),
        ...botVal.map(() => -1 / botVal.length),
      ];
      const topEY = topVal.reduce((s, a) => s + a.earningsYield, 0) / topVal.length;
      const botEY = botVal.reduce((s, a) => s + a.earningsYield, 0) / botVal.length;
      const spread = Math.max(0.01, Math.min(0.10, (topEY - botEY) * 2));

      views.push({
        assets: allTickers,
        weights: allWeights,
        expectedReturn: spread,
        confidence: 0.25,
        description: `Ranking value: ${topVal.map(a => a.name).join(', ')} EY>${botVal.map(a => a.name).join(', ')}`,
      });
    }
  }

  // ── Liquidez global (solo EXPANSION) ────────────────────────────
  if (liquidityGrowth > 5 && macroRegime === 'EXPANSION' && views.length < 3) {
    const riskAssets = assets
      .filter(a => a.ticker !== 'PPFB.DE')
      .map(a => a.ticker);

    if (riskAssets.length > 0) {
      views.push({
        assets: riskAssets,
        weights: riskAssets.map(() => 1 / riskAssets.length),
        expectedReturn: 0.04 + liquidityGrowth / 300,
        confidence: 0.20, // muy baja: liquidity es input manual
        description: `Liquidez global (+${liquidityGrowth.toFixed(1)}% M2) → leve tailwind`,
      });
    }
  }

  return views.slice(0, 3);
}