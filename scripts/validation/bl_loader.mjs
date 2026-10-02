// ============================================================
// scripts/validation/bl_loader.mjs
// TEST 5 — hook de carga ESM: reescribe blackLitterman.ts ANTES del enlazado
// (sin editar src/ en disco): renombra la función original y añade un wrapper
// que aplica la fórmula preregistrada confianza × max(0.25, breadth_pos).
// Se activa/desactiva con globalThis.__BL_ON (default OFF = motor intacto).
// ============================================================
export async function load(url, context, next) {
  const r = await next(url, context);

  if (/blackLitterman\.ts(\?.*)?$/.test(url) && r && r.source != null) {
    let src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
    if (src.includes('function generateViewsExternal(')) {
      src = src.replace(/function generateViewsExternal\(/, 'function __blOrig_generateViewsExternal(');
      if (src.includes('__blOrig_generateViewsExternal')) {
        src += '\nfunction generateViewsExternal(assets, macroRegime, liquidityGrowth) {\n' +
          '  const views = __blOrig_generateViewsExternal(assets, macroRegime, liquidityGrowth);\n' +
          '  const n = Array.isArray(assets) ? assets.length : 0;\n' +
          '  const pos = n > 0 ? assets.filter(a => a.returns12m > 0).length / n : 1;\n' +
          '  const mult = Math.max(0.25, pos);\n' +
          '  const g = globalThis;\n' +
          '  g.__BL_STATE = { breadthPos: pos, mult, n };\n' +
          '  g.__BL_STATS = g.__BL_STATS || { calls: 0, reduced: 0, sumMult: 0 };\n' +
          '  g.__BL_STATS.calls++; g.__BL_STATS.sumMult += mult; if (mult < 0.999) g.__BL_STATS.reduced++;\n' +
          '  if (!g.__BL_ON) return views;\n' +
          '  return views.map(v => Object.assign({}, v, { confidence: v.confidence * mult }));\n' +
          '}\n';
        return { format: 'module', source: src, shortCircuit: true };
      }
    }
  }
  return r;
}
