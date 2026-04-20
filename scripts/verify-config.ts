#!/usr/bin/env node
/**
 * verify-config.ts
 * Script de verificación de configuración del motor Olympus
 *
 * Verifica:
 * - IBKR Gateway (account U25387834)
 * - Supabase conexión
 * - Variables de entorno
 * - Docker containers
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color: string, message: string) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function checkFile(path: string): boolean {
  return existsSync(path);
}

function checkEnvVar(env: Record<string, string>, key: string): boolean {
  return !!env[key] && env[key] !== 'REPLACE_ME' && !env[key].includes('REPLACE');
}

async function checkIBKRGateway(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch('http://localhost:5000/v1/api/iserver/auth/status', {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

async function checkSupabase(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${url}/rest/v1/`, {
      signal: controller.signal,
      headers: { apikey: 'test' }
    });

    clearTimeout(timeout);
    // Supabase devuelve 400/401 si la URL es válida pero falta auth
    return response.status === 400 || response.status === 401 || response.ok;
  } catch {
    return false;
  }
}

async function checkDocker(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process');
    execSync('docker ps', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  log(COLORS.cyan, '╔════════════════════════════════════════════════════════╗');
  log(COLORS.cyan, '║   OLYMPUS CAPITAL — Verificación de Configuración     ║');
  log(COLORS.cyan, '╚════════════════════════════════════════════════════════╝');
  console.log('');

  const errors: string[] = [];
  const warnings: string[] = [];
  const successes: string[] = [];

  // ── 1. Verificar archivos de configuración ─────────────────
  log(COLORS.blue, '📁 Archivos de configuración');
  console.log('─'.repeat(50));

  const configFiles = [
    '.env',
    '.env.local',
    'docker-compose.yml',
    'src/core/tactical/ibkrConnector.ts',
    'src/lib/marketData.ts',
    'src/integrations/supabase/client.ts',
  ];

  for (const file of configFiles) {
    if (checkFile(file)) {
      log(COLORS.green, `  ✓ ${file}`);
      successes.push(`Archivo: ${file}`);
    } else {
      log(COLORS.red, `  ✗ ${file} (NO ENCONTRADO)`);
      errors.push(`Archivo faltante: ${file}`);
    }
  }
  console.log('');

  // ── 2. Verificar variables de entorno ──────────────────────
  log(COLORS.blue, '🔐 Variables de entorno');
  console.log('─'.repeat(50));

  try {
    const envContent = readFileSync('.env', 'utf-8');
    const env: Record<string, string> = {};

    envContent.split('\n').forEach(line => {
      // Saltar comentarios y líneas vacías
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const match = trimmed.match(/^([^=#]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].replace(/^["']|["']$/g, '').trim();
        env[key] = value;
      }
    });

    // IBKR
    if (checkEnvVar(env, 'IBKR_ACCOUNT_ID')) {
      log(COLORS.green, `  ✓ IBKR_ACCOUNT_ID: ${env['IBKR_ACCOUNT_ID']}`);
      successes.push('IBKR Account ID configurado');
    } else {
      log(COLORS.yellow, `  ⚠ IBKR_ACCOUNT_ID: No configurada o inválida`);
      warnings.push('IBKR_ACCOUNT_ID faltante en .env');
    }

    if (checkEnvVar(env, 'IBKR_GATEWAY_URL')) {
      log(COLORS.green, `  ✓ IBKR_GATEWAY_URL: ${env['IBKR_GATEWAY_URL']}`);
      successes.push('IBKR Gateway URL configurada');
    } else {
      log(COLORS.yellow, `  ⚠ IBKR_GATEWAY_URL: No configurada`);
      warnings.push('IBKR_GATEWAY_URL faltante en .env');
    }

    // Supabase
    if (checkEnvVar(env, 'VITE_SUPABASE_URL')) {
      log(COLORS.green, `  ✓ VITE_SUPABASE_URL: ${env['VITE_SUPABASE_URL']}`);
      successes.push('Supabase URL configurada');
    } else {
      log(COLORS.red, `  ✗ VITE_SUPABASE_URL: No configurada`);
      errors.push('VITE_SUPABASE_URL faltante');
    }

    if (checkEnvVar(env, 'VITE_SUPABASE_ANON_KEY')) {
      const keyPreview = env['VITE_SUPABASE_ANON_KEY'].substring(0, 20) + '...';
      log(COLORS.green, `  ✓ VITE_SUPABASE_ANON_KEY: ${keyPreview}`);
      successes.push('Supabase Anon Key configurada');
    } else {
      log(COLORS.red, `  ✗ VITE_SUPABASE_ANON_KEY: No configurada o inválida`);
      errors.push('VITE_SUPABASE_ANON_KEY faltante o inválida');
    }

    // Telegram
    if (checkEnvVar(env, 'TELEGRAM_BOT_TOKEN')) {
      log(COLORS.green, `  ✓ TELEGRAM_BOT_TOKEN: configurado`);
      successes.push('Telegram Bot Token configurado');
    } else {
      log(COLORS.yellow, `  ⚠ TELEGRAM_BOT_TOKEN: No configurado`);
      warnings.push('Telegram no funcionará sin token');
    }
  } catch (e: any) {
    log(COLORS.red, `  Error leyendo .env: ${e.message}`);
    errors.push(`Error leyendo .env: ${e.message}`);
  }
  console.log('');

  // ── 3. Verificar IBKR Connector ────────────────────────────
  log(COLORS.blue, '📡 Conector IBKR');
  console.log('─'.repeat(50));

  try {
    const ibkrContent = readFileSync('src/core/tactical/ibkrConnector.ts', 'utf-8');

    if (ibkrContent.includes('U25387834')) {
      log(COLORS.green, `  ✓ Account ID: U25387834 configurado`);
      successes.push('IBKR Account ID en ibkrConnector.ts');
    } else if (ibkrContent.includes("accountId:  ''")) {
      log(COLORS.yellow, `  ⚠ Account ID: Vacío (debe ser U25387834)`);
      warnings.push('ibkrConnector.ts tiene accountId vacío');
    } else {
      log(COLORS.green, `  ✓ Account ID configurado`);
    }

    if (ibkrContent.includes("enabled:    true") || ibkrContent.includes('enabled: true')) {
      log(COLORS.green, `  ✓ IBKR: Habilitado`);
      successes.push('IBKR habilitado en connector');
    } else {
      log(COLORS.yellow, `  ⚠ IBKR: Puede estar deshabilitado`);
      warnings.push('IBKR enabled puede ser false');
    }
  } catch (e: any) {
    log(COLORS.red, `  Error leyendo ibkrConnector.ts: ${e.message}`);
    errors.push(`Error leyendo ibkrConnector.ts: ${e.message}`);
  }
  console.log('');

  // ── 4. Verificar servicios (Docker, IBKR, Supabase) ───────
  log(COLORS.blue, '🔧 Servicios');
  console.log('─'.repeat(50));

  // Docker
  const dockerRunning = await checkDocker();
  if (dockerRunning) {
    log(COLORS.green, `  ✓ Docker: Disponible`);
    successes.push('Docker disponible');
  } else {
    log(COLORS.yellow, `  ⚠ Docker: No disponible o no instalado`);
    warnings.push('Docker no está disponible');
  }

  // IBKR Gateway
  const ibkrOnline = await checkIBKRGateway();
  if (ibkrOnline) {
    log(COLORS.green, `  ✓ IBKR Gateway: ONLINE (localhost:5000)`);
    successes.push('IBKR Gateway respondiendo');
  } else {
    log(COLORS.yellow, `  ⚠ IBKR Gateway: OFFLINE`);
    warnings.push('IBKR Gateway no responde. Ejecutar: docker-compose up -d ibkr-gateway');
    if (dockerRunning) {
      console.log('     Para iniciar: docker-compose up -d ibkr-gateway');
    }
  }

  // Supabase
  try {
    const envContent = readFileSync('.env', 'utf-8');
    const supabaseUrlMatch = envContent.match(/VITE_SUPABASE_URL=["']?([^"'\n\r]+)["']?/);
    if (supabaseUrlMatch) {
      const supabaseUrl = supabaseUrlMatch[1].trim();
      const supabaseOnline = await checkSupabase(supabaseUrl);
      if (supabaseOnline) {
        log(COLORS.green, `  ✓ Supabase: ONLINE (${supabaseUrl})`);
        successes.push('Supabase respondiendo');
      } else {
        log(COLORS.yellow, `  ⚠ Supabase: No responde`);
        warnings.push('Supabase no responde desde la URL configurada');
      }
    }
  } catch {
    log(COLORS.yellow, `  ⚠ Supabase: No se pudo verificar`);
  }
  console.log('');

  // ── 5. Resumen ─────────────────────────────────────────────
  log(COLORS.cyan, '╔════════════════════════════════════════════════════════╗');
  log(COLORS.cyan, '║                    RESUMEN                             ║');
  log(COLORS.cyan, '╚════════════════════════════════════════════════════════╝');
  console.log('');

  if (successes.length > 0) {
    log(COLORS.green, `✓ Correcto: ${successes.length}`);
  }
  if (warnings.length > 0) {
    log(COLORS.yellow, `⚠ Advertencias: ${warnings.length}`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  if (errors.length > 0) {
    log(COLORS.red, `✗ Errores: ${errors.length}`);
    errors.forEach(e => console.log(`   - ${e}`));
  }

  console.log('');

  if (errors.length === 0 && warnings.length === 0) {
    log(COLORS.green, '🎉 ¡Configuración completa! Todo está listo.');
  } else if (errors.length === 0) {
    log(COLORS.yellow, '⚠ Hay advertencias que deberías revisar.');
  } else {
    log(COLORS.red, '❌ Hay errores que deben corregirse antes de continuar.');
  }

  console.log('');

  // Exit codes
  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
