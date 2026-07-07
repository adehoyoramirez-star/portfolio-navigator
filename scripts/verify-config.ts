#!/usr/bin/env node
/**
 * verify-config.ts
 * Script de verificación de configuración del motor Olympus
 *
 * Verifica:
 * - Supabase conexión
 * - Variables de entorno
 * - Docker containers
 */

import { readFileSync, existsSync } from 'fs';

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

async function checkSupabase(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${url}/rest/v1/`, {
      signal: controller.signal,
      headers: { apikey: 'test' }
    });
    clearTimeout(timeout);
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
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const match = trimmed.match(/^([^=#]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].replace(/^["']|["']$/g, '').trim();
        env[key] = value;
      }
    });

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

    // GEMINI_API_KEY removed
  } catch (e: any) {
    log(COLORS.red, `  Error leyendo .env: ${e.message}`);
    errors.push(`Error leyendo .env: ${e.message}`);
  }
  console.log('');

  // ── 3. Verificar servicios (Docker, Supabase) ───────
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

  // ── 4. Resumen ─────────────────────────────────────────────
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

  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
