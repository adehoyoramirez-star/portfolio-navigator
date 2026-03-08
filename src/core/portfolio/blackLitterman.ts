// ===============================================
// BLACK-LITTERMAN PORTFOLIO MODEL
// ===============================================
// Desarrollado por Fischer Black y Robert Litterman en Goldman Sachs (1990).
// Estándar institucional usado por Goldman, BlackRock y la mayoría de
// gestoras cuantitativas de primer nivel.
//
// EL PROBLEMA QUE RESUELVE:
// El Markowitz clásico tiene un defecto grave: es extremadamente sensible
// a pequeñas variaciones en los retornos esperados. Si estimas que un activo
// va a rendir 10.1% en lugar de 10.0%, los pesos óptimos pueden cambiar
// radicalmente. En la práctica esto significa que el portfolio Markowitz
// tiende a concentrarse masivamente en 1-2 activos y a cambiar mucho
// de un período a otro — lo contrario de lo que queremos.
//
// LA SOLUCIÓN BLACK-LITTERMAN:
// En lugar de usar retornos esperados directamente, el modelo combina:
//   1. "Equilibrium returns" — los retornos implícitos que justificarían
//      los pesos de mercado actuales (inferidos desde la covarianza)
//   2. "Investor views" — tus opiniones sobre retornos futuros, con
//      niveles de confianza explícitos
// El resultado es una mezcla estadística (Bayesiana) de ambas fuentes
// que produce pesos mucho más estables y diversificados.
//
// FLUJO:
//   covMatrix + marketWeights
//       ↓
//   Π = δ × Σ × w_mkt  (retornos de equilibrio)
//       ↓
//   Combinar con views mediante fórmula Bayesiana
//       ↓
//   μ_BL = pesos óptimos Black-Litterman
//       ↓
//   Optimización de mínima varianza sobre μ_BL
// ===============================================

export interface BLView {
  // Una "view" es tu opinión sobre el retorno futuro de un activo o grupo
  assets: string[];           // activos involucrados (["BTC-EUR"] o ["VVSM.DE", "IS3Q.DE"])
  weights: number[];          // pesos dentro de la view (suma = 1 si relativa, [1] si absoluta)
  expectedReturn: number;     // retorno esperado en decimal (ej: 0.15 = +15%)
  confidence: number;         // confianza en la view 0-1 (0.5 = bastante incierto, 0.9 = muy seguro)
  description?: string;       // descripción legible para el UI
}

export interface BLInput {
  assetNames: string[];       // nombres de los activos en el mismo orden que covMatrix
  covMatrix: number[][];      // matriz de covarianza real (N×N)
  marketWeights: number[];    // pesos de mercado actuales (capitalización o pesos del portfolio)
  views: BLView[];            // tus opiniones sobre retornos futuros
  riskAversion?: number;      // parámetro δ de aversión al riesgo (default 2.5)
  tau?: number;               // escala de incertidumbre sobre equilibrio (default 0.05)
}

export interface BLOutput {
  equilibriumReturns: number[];   // Π — retornos implícitos de mercado
  posteriorReturns: number[];     // μ_BL — retornos ajustados tras incorporar views
  posteriorWeights: number[];     // pesos óptimos Black-Litterman (suma = 1)
  viewImpact: {                   // cuánto ha movido cada view los pesos
    view: BLView;
    priorReturn: number;          // retorno de equilibrio antes de la view
    posteriorReturn: number;      // retorno posterior después de la view
    weightChange: number;         // cambio en el peso del activo principal
  }[];
}

/**
 * Calcula los retornos implícitos de equilibrio de mercado (Π).
 * Estos son los retornos que "justificarían" los pesos de mercado actuales
 * dada la matriz de covarianza — es decir, lo que el mercado ya "sabe".
 *
 * Fórmula: Π = δ × Σ × w_mkt
 * donde δ es el coeficiente de aversión al riesgo global (típicamente 2-3)
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
 * Construye la matriz P (picking matrix) y vector Q (expected returns de las views).
 * P tiene dimensión (K × N) donde K = número de views, N = número de activos.
 * Cada fila de P describe qué activos involucra esa view y con qué peso.
 */
function buildPickingMatrices(
  views: BLView[],
  assetNames: string[]
): { P: number[][]; Q: number[]; omega: number[] } {
  const n = assetNames.length;
  const k = views.length;

  // P: matriz de picking (K×N)
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

  // Ω (omega): matriz diagonal de incertidumbre de las views
  // Una view con confidence=0.9 tiene poca incertidumbre → omega pequeño
  // Una view con confidence=0.3 tiene mucha incertidumbre → omega grande
  // omega_i = (1 - confidence_i) / confidence_i × (P_i × Σ × P_i^T)
  const omega: number[] = views.map((view, vi) => {
    const pRow = P[vi];
    // Calcular P_i × Σ × P_i^T (varianza de la view bajo la covarianza del portfolio)
    let viewVariance = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        viewVariance += pRow[i] * pRow[j] * (0.01 * 0.01); // approximación diagonal
      }
    }
    const uncertaintyRatio = (1 - view.confidence) / (view.confidence + 1e-10);
    return Math.max(0.0001, uncertaintyRatio * Math.max(viewVariance, 0.0001));
  });

  return { P, Q, omega };
}

/**
 * Función principal de Black-Litterman.
 * Implementa la fórmula posterior Bayesiana completa.
 *
 * Fórmula del retorno posterior:
 * μ_BL = [(τΣ)^{-1} + P^T Ω^{-1} P]^{-1} × [(τΣ)^{-1} Π + P^T Ω^{-1} Q]
 *
 * Esta fórmula mezcla el prior (equilibrio de mercado escalado por τ)
 * con las views del inversor ponderadas por su confianza inversa.
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

  // Si no hay views, retornamos equilibrio directamente
  if (views.length === 0) {
    const weights = minimumVarianceBL(covMatrix, equilibriumReturns, n);
    return {
      equilibriumReturns,
      posteriorReturns: equilibriumReturns,
      posteriorWeights: weights,
      viewImpact: [],
    };
  }

  // PASO 2: Construir matrices de views
  const { P, Q, omega } = buildPickingMatrices(views, assetNames);
  const k = views.length;

  // PASO 3: Fórmula Black-Litterman Bayesiana (versión simplificada estable)
  // Usamos la versión de He & Litterman (1999) que es numéricamente más estable:
  // μ_BL = Π + τΣP^T (PτΣP^T + Ω)^{-1} (Q - PΠ)
  //
  // Esto es equivalente a la fórmula completa pero más fácil de implementar
  // sin inversión de matrices de gran dimensión.

  // Calcular τΣ (covarianza escalada)
  const tauSigma = covMatrix.map(row => row.map(v => v * tau));

  // Calcular PτΣ (K×N)
  const PtauSigma: number[][] = Array.from({ length: k }, (_, ki) =>
    Array.from({ length: n }, (_, ni) =>
      P[ki].reduce((sum, p, pi) => sum + p * tauSigma[pi][ni], 0)
    )
  );

  // Calcular PτΣP^T (K×K) + Ω (diagonal)
  const M: number[][] = Array.from({ length: k }, (_, ki) =>
    Array.from({ length: k }, (_, kj) =>
      P[ki].reduce((sum, p, pi) => sum + p * PtauSigma[kj][pi], 0) +
      (ki === kj ? omega[ki] : 0)
    )
  );

  // Calcular Q - PΠ (desviación de las views respecto al equilibrio)
  const qMinusPPi: number[] = Array.from({ length: k }, (_, ki) =>
    Q[ki] - P[ki].reduce((sum, p, pi) => sum + p * equilibriumReturns[pi], 0)
  );

  // Invertir M (matriz K×K — pequeña, inversión directa es estable)
  const Minv = invertMatrix(M, k);

  // Calcular M^{-1}(Q - PΠ) (K×1)
  const MinvQPi: number[] = Array.from({ length: k }, (_, ki) =>
    Minv[ki].reduce((sum, m, kj) => sum + m * qMinusPPi[kj], 0)
  );

  // Calcular τΣP^T (N×K) × M^{-1}(Q-PΠ) = ajuste final (N×1)
  const adjustment: number[] = Array.from({ length: n }, (_, ni) =>
    Array.from({ length: k }, (_, ki) =>
      PtauSigma[ki][ni] * MinvQPi[ki]
    ).reduce((a, b) => a + b, 0)
  );

  // μ_BL = Π + ajuste
  const posteriorReturns = equilibriumReturns.map((pi, i) => pi + adjustment[i]);

  // PASO 4: Pesos óptimos usando los retornos posteriores
  const posteriorWeights = minimumVarianceBL(covMatrix, posteriorReturns, n);

  // PASO 5: Calcular impacto de cada view para el UI
  const viewImpact = views.map((view, _vi) => {
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
 * Inclinamos los pesos hacia activos con mayor retorno esperado BL
 * pero penalizamos la varianza — balance entre retorno y riesgo.
 */
function minimumVarianceBL(
  covMatrix: number[][],
  expectedReturns: number[],
  n: number
): number[] {
  // Comenzar desde equal weight y ajustar por retornos esperados
  let weights = new Array(n).fill(1 / n);

  // Gradient descent para minimizar: w^T Σ w - λ × μ^T w
  // donde λ=0.5 balancea retorno vs riesgo
  const lambda = 0.5;
  const learningRate = 0.01;
  const iterations = 200;

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      // Gradiente de varianza: 2 × Σ_i × w
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * covMatrix[i][j] * weights[j];
      }
      // Gradiente de retorno esperado (negativo porque minimizamos)
      grad[i] -= lambda * expectedReturns[i];
    }

    // Actualizar pesos
    for (let i = 0; i < n; i++) {
      weights[i] -= learningRate * grad[i];
    }

    // Proyectar a simplex (pesos positivos que sumen 1)
    weights = projectToSimplex(weights, n);
  }

  return weights;
}

/** Proyecta un vector al simplex estándar (pesos ≥ 0, suma = 1) */
function projectToSimplex(w: number[], n: number): number[] {
  // Clamp a positivo
  const pos = w.map(x => Math.max(0, x));
  const sum = pos.reduce((a, b) => a + b, 0);
  if (sum === 0) return new Array(n).fill(1 / n);
  return pos.map(x => x / sum);
}

/**
 * Inversión de matriz cuadrada pequeña usando eliminación de Gauss-Jordan.
 * Solo se usa para matrices K×K donde K = número de views (típicamente 2-5).
 */
function invertMatrix(M: number[][], n: number): number[][] {
  // Crear matriz aumentada [M | I]
  const aug: number[][] = M.map((row, i) => [
    ...row.map(v => v),
    ...new Array(n).fill(0).map((_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    // Encontrar el pivote
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) {
      // Matriz singular — retornar identidad como fallback
      return Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
      );
    }

    // Normalizar fila pivote
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;

    // Eliminar columna
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
 * Las views se derivan de las señales que ya calcula el motor:
 * momentum fuerte → view positiva, momentum negativo → view negativa.
 * Esto conecta el análisis fundamental del motor con Black-Litterman.
 */
export function generateViewsFromEngine(
  assets: { name: string; ticker: string; momentumScore: number; valuePercentileRank: number }[],
  macroRegime: string,
  liquidityGrowth: number
): BLView[] {
  const views: BLView[] = [];

  assets.forEach(asset => {
    // VIEW DE MOMENTUM: activos con momentum fuerte > 0.3 merecen view positiva
    if (asset.momentumScore > 0.3) {
      views.push({
        assets: [asset.ticker],
        weights: [1],
        expectedReturn: 0.08 + asset.momentumScore * 0.15, // 8-23% según momentum
        confidence: Math.min(0.85, 0.5 + asset.momentumScore * 0.5),
        description: `Momentum fuerte (${asset.momentumScore.toFixed(2)}) en ${asset.name}`,
      });
    }

    // VIEW DE VALUE: activos baratos (percentil bajo = más baratos) merecen view positiva
    // percentileRank bajo = earnings yield alto = más barato
    if (asset.valuePercentileRank < 30 && asset.valuePercentileRank > 0) {
      views.push({
        assets: [asset.ticker],
        weights: [1],
        expectedReturn: 0.06 + (30 - asset.valuePercentileRank) / 100,
        confidence: 0.6, // value investing es menos preciso en el timing
        description: `Valoración atractiva (percentil ${asset.valuePercentileRank}) en ${asset.name}`,
      });
    }
  });

  // VIEW MACRO: si liquidez global es alta y régimen mejora → renta variable en general
  if (liquidityGrowth > 5 && macroRegime !== 'CRISIS') {
    const riskAssets = assets
      .filter(a => !['PPFB.DE'].includes(a.ticker)) // excluir oro
      .map(a => a.ticker);

    if (riskAssets.length > 0) {
      views.push({
        assets: riskAssets,
        weights: riskAssets.map(() => 1 / riskAssets.length),
        expectedReturn: 0.06 + liquidityGrowth / 200, // +3% extra con liquidez al 6%
        confidence: 0.55,
        description: `Liquidez global positiva (+${liquidityGrowth.toFixed(1)}%) → tailwind para renta variable`,
      });
    }
  }

  // Limitar a máximo 5 views para mantener la matriz K×K manejable
  return views.slice(0, 5);
}