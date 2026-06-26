// Script para ejecutar el scan táctico y capturar logs
import { createClient } from '@supabase/supabase-js';

// Supabase credentials (del proyecto)
const supabaseUrl = 'https://yrirandgftnuvdzatwgc.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyaXJhbmRnZnRudXZkemF0d2djIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzg2NTQzOTcsImV4cCI6MjA1NDIzMDM5N30.8AR8Vf4ud-n7nrQ0t7xRrFS3_Wlj8-CWPqg6TifZbjY';

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('='.repeat(60));
  console.log('INICIANDO SCAN TÁCTICO DESDE NODE.JS');
  console.log('='.repeat(60));

  // Guardar los logs originales
  const logs = [];
  const originalLog = console.log;
  const originalDebug = console.debug;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args) => {
    logs.push({ level: 'LOG', text: args.join(' ') });
    originalLog(...args);
  };
  console.debug = (...args) => {
    logs.push({ level: 'DEBUG', text: args.join(' ') });
    originalDebug(...args);
  };
  console.warn = (...args) => {
    logs.push({ level: 'WARN', text: args.join(' ') });
    originalWarn(...args);
  };
  console.error = (...args) => {
    logs.push({ level: 'ERROR', text: args.join(' ') });
    originalError(...args);
  };

  try {
    // Importar dinámicamente
    const { scanTacticalUniverse, defaultTacticalConfig } = await import('./src/core/tactical/tacticalScreener.ts');

    const config = defaultTacticalConfig(1000, 500);
    console.log('Config:', JSON.stringify(config, null, 2));

    const result = await scanTacticalUniverse('core', config, supabase);

    console.log('\n' + '='.repeat(60));
    console.log('SCAN COMPLETADO');
    console.log('='.repeat(60));
    console.log(`Oportunidades: ${result.opportunities.length}`);
    console.log(`Assets: ${result.assets.length}`);
    console.log(`Errors: ${result.errors.length}`);
    console.log(`Warnings: ${result.warnings.length}`);

    for (const opp of result.opportunities) {
      console.log(`  ${opp.asset.ticker} | Score: ${opp.score} | R:R: ${opp.riskReward.toFixed(2)} | Type: ${opp.type} | ExecScore: ${opp.executionScore}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('LOGS CAPTURADOS');
    console.log('='.repeat(60));

    // Mostrar SOLO los logs relevantes
    for (const log of logs) {
      const text = log.text;
      if (
        text.includes('[AINarrative]') ||
        text.includes('[Screener]') ||
        text.includes('Macro eventos') ||
        text.includes('TOP 5 PRIORIDADES') ||
        text.includes('DIAGNÓSTICO') ||
        text.includes('Señales generadas') ||
        text.includes('AUDITORÍA DE SEÑALES') ||
        text.includes('SOBREAJUSTE') ||
        text.includes('macroSignal') ||
        text.includes('narrative') ||
        text.includes('narrativas') ||
        text.includes('USANDO CACHÉ')
      ) {
        console.log(`[${log.level}] ${log.text}`);
      }
    }

  } catch (err) {
    console.error('ERROR:', err);
  }
}

main().catch(console.error);
