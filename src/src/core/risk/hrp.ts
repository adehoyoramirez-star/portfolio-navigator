// ===============================================
// ARCHIVO: src/core/risk/hrp.ts
// Hierarchical Risk Parity (HRP) — López de Prado (2016)
// ===============================================
// HRP es superior al risk parity estándar porque:
//   1. No requiere invertir la matriz de covarianza (evita errores numéricos)
//   2. Agrupa activos similares antes de distribuir el riesgo
//   3. Es más estable out-of-sample que Markowitz y risk parity
//   4. Funciona bien con pocos activos (exactamente nuestro caso: 7)
//
// Algoritmo:
//   PASO 1: Tree clustering
//     - Convertir covarianza en distancias de correlación
//     - Construir árbol jerárquico (dendrograma) por similitud
//   PASO 2: Quasi-diagonalización
//     - Reordenar matriz de covarianza según el árbol
//   PASO 3: Recursive bisection
//     - Dividir el portfolio en 2 clusters en cada nivel
//     - Distribuir riesgo inversamente proporcional a la var del cluster
//
// Para 7 activos:
//   Cluster A: BTC + activos especulativos (alta correlación entre sí)
//   Cluster B: Oro + activos defensivos
//   Cluster C: ETFs de renta variable globales
//   → HRP distribuye el riesgo entre clusters, no solo entre activos
// ===============================================

// ── PASO 1: DISTANCIAS Y CLUSTERING ─────────────────────────────────────────

function correlationFromCov(cov: number[][]): number[][] {
  const n = cov.length;
  const corr: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const denom = Math.sqrt(Math.abs(cov[i][i] * cov[j][j]));
      corr[i][j] = denom > 0 ? cov[i][j] / denom : (i === j ? 1 : 0);
    }
  }
  return corr;
}

// Distancia de correlación: d(i,j) = sqrt(0.5 * (1 - rho(i,j)))
function correlationDistance(corr: number[][]): number[][] {
  const n = corr.length;
  const dist: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      dist[i][j] = Math.sqrt(Math.max(0, 0.5 * (1 - corr[i][j])));
    }
  }
  return dist;
}

// Single-linkage clustering simplificado (para n pequeño ≤ 10)
// Devuelve el orden de los activos según el árbol jerárquico
function hierarchicalCluster(dist: number[][]): number[] {
  const n = dist.length;
  if (n <= 1) return [0];

  // Algoritmo de single-linkage iterativo
  // Cada paso fusiona los 2 clusters más cercanos
  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);

  while (clusters.length > 1) {
    let minDist = Infinity;
    let mergeA = 0;
    let mergeB = 1;

    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        // Distancia single-linkage: mínimo entre todos los pares
        let d = Infinity;
        for (const i of clusters[a]) {
          for (const j of clusters[b]) {
            if (dist[i][j] < d) d = dist[i][j];
          }
        }
        if (d < minDist) {
          minDist = d;
          mergeA = a;
          mergeB = b;
        }
      }
    }

    // Fusionar clusters manteniendo el orden jerárquico
    const merged = [...clusters[mergeA], ...clusters[mergeB]];
    clusters = clusters.filter((_, i) => i !== mergeA && i !== mergeB);
    clusters.push(merged);
  }

  return clusters[0]; // orden final del dendrograma
}

// ── PASO 2: QUASI-DIAGONALIZACIÓN ──────────────────────────────────────────
// Reordenar la covarianza según el orden del clustering
function quasiDiagonalize(cov: number[][], order: number[]): number[][] {
  const n = order.length;
  const reordered: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      reordered[i][j] = cov[order[i]][order[j]];
    }
  }
  return reordered;
}

// ── PASO 3: RECURSIVE BISECTION ─────────────────────────────────────────────
// Distribuir los pesos recursivamente entre sub-clusters
function getClusterVar(cov: number[][], indices: number[]): number {
  // Varianza del cluster igual-ponderado
  const n = indices.length;
  if (n === 0) return 0;
  let variance = 0;
  for (const i of indices) {
    for (const j of indices) {
      variance += cov[i][j];
    }
  }
  return variance / (n * n);
}

function recursiveBisection(
  cov: number[][],
  sortedItems: number[],
  weights: number[],
  weight: number = 1.0
): void {
  if (sortedItems.length === 1) {
    weights[sortedItems[0]] = weight;
    return;
  }

  const half = Math.floor(sortedItems.length / 2);
  const leftItems = sortedItems.slice(0, half);
  const rightItems = sortedItems.slice(half);

  const varLeft  = getClusterVar(cov, leftItems);
  const varRight = getClusterVar(cov, rightItems);

  // Inversamente proporcional a la varianza del cluster
  const total = varLeft + varRight;
  const weightLeft  = total > 0 ? (1 - varLeft  / total) * weight : weight / 2;
  const weightRight = total > 0 ? (1 - varRight / total) * weight : weight / 2;

  recursiveBisection(cov, leftItems,  weights, weightLeft);
  recursiveBisection(cov, rightItems, weights, weightRight);
}

// ── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────
export interface HRPResult {
  weights: number[];          // pesos HRP normalizados [0,1], suma=1
  clusterOrder: number[];     // orden del dendrograma (para visualización)
  clusterGroups: number[][];  // grupos de activos similares
}

export function computeHRP(covMatrix: number[][], n: number): HRPResult {
  // Fallback: equal weight si no hay covMatrix válida
  if (!covMatrix || covMatrix.length < 2) {
    return {
      weights: new Array(n).fill(1 / n),
      clusterOrder: Array.from({ length: n }, (_, i) => i),
      clusterGroups: [Array.from({ length: n }, (_, i) => i)],
    };
  }

  try {
    // PASO 1: clustering
    const corr = correlationFromCov(covMatrix);
    const dist = correlationDistance(corr);
    const clusterOrder = hierarchicalCluster(dist);

    // PASO 2: quasi-diagonalización
    const reorderedCov = quasiDiagonalize(covMatrix, clusterOrder);

    // PASO 3: recursive bisection en el espacio reordenado
    const reorderedWeights = new Array(covMatrix.length).fill(0);
    const reorderedIndices = Array.from({ length: covMatrix.length }, (_, i) => i);
    recursiveBisection(reorderedCov, reorderedIndices, reorderedWeights);

    // Mapear de vuelta al orden original
    const weights = new Array(n).fill(0);
    for (let i = 0; i < clusterOrder.length; i++) {
      weights[clusterOrder[i]] = reorderedWeights[i];
    }

    // Normalizar (por seguridad)
    const total = weights.reduce((s, w) => s + w, 0);
    const normalized = total > 0 ? weights.map(w => w / total) : weights.map(() => 1 / n);

    // Detectar grupos de activos correlacionados
    const clusterGroups = detectClusterGroups(clusterOrder, corr);

    return { weights: normalized, clusterOrder, clusterGroups };
  } catch {
    // Si algo falla, fallback a equal weight
    return {
      weights: new Array(n).fill(1 / n),
      clusterOrder: Array.from({ length: n }, (_, i) => i),
      clusterGroups: [Array.from({ length: n }, (_, i) => i)],
    };
  }
}

// Detectar grupos de activos con correlación > 0.5
function detectClusterGroups(order: number[], corr: number[][]): number[][] {
  const groups: number[][] = [];
  const assigned = new Set<number>();

  for (const i of order) {
    if (assigned.has(i)) continue;
    const group = [i];
    assigned.add(i);
    for (const j of order) {
      if (!assigned.has(j) && Math.abs(corr[i][j]) > 0.5) {
        group.push(j);
        assigned.add(j);
      }
    }
    groups.push(group);
  }

  return groups;
}