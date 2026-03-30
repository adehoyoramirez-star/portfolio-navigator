// ===============================================
// ARCHIVO: src/core/config/logger.ts
// SISTEMA DE LOGGING CON NIVELES
// LOW-02: Logs en producción con niveles configurables
// ===============================================
// Sistema de logging que permite:
//   - Niveles: DEBUG, INFO, WARN, ERROR
//   - Habilitar/deshabilitar en producción
//   - Filtrar por módulo
//   - Formato estructurado para análisis
//
// Uso:
//   import { logger } from '@/core/config/logger';
//   logger.info('Olympus', 'Engine initialized', { version: '3.5.1' });
//   logger.warn('CEWS', 'VIX elevated', { vix: 32 });
//   logger.error('HRP', 'Matrix inversion failed', { matrix: covMatrix });
// ===============================================

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE";

export interface LogConfig {
  level: LogLevel;
  enabledModules: string[] | "*";  // "*" = todos, [] = ninguno
  includeTimestamp: boolean;
  includeStackTrace: boolean;      // solo para ERROR
  outputToConsole: boolean;
  outputToStorage: boolean;        // guardar en localStorage
  storageKey: string;
  maxStoredLogs: number;
}

// ── CONFIGURACIÓN POR ENTORNO ───────────────────────────────────────────────
const DEFAULT_CONFIG: LogConfig = {
  level: import.meta.env.PROD ? "WARN" : "DEBUG",  // En prod solo WARN+, en dev todo
  enabledModules: "*",
  includeTimestamp: true,
  includeStackTrace: true,
  outputToConsole: true,
  outputToStorage: import.meta.env.PROD,           // Solo en prod guardar logs
  storageKey: "olympus_logs_v1",
  maxStoredLogs: 100,
};

// Configuración runtime (puede modificarse)
let config: LogConfig = { ...DEFAULT_CONFIG };

// Nivel numérico para comparación
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 999,
};

// ── ALMACENAMIENTO DE LOGS ──────────────────────────────────────────────────
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
  stack?: string;
}

const logBuffer: LogEntry[] = [];

function shouldLog(level: LogLevel, module: string): boolean {
  // Verificar nivel
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[config.level]) {
    return false;
  }

  // Verificar módulo
  if (config.enabledModules !== "*") {
    if (!config.enabledModules.includes(module)) {
      return false;
    }
  }

  return true;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function saveToStorage(entry: LogEntry): void {
  if (!config.outputToStorage) return;

  try {
    logBuffer.push(entry);
    if (logBuffer.length > config.maxStoredLogs) {
      logBuffer.shift();
    }
    localStorage.setItem(config.storageKey, JSON.stringify(logBuffer.slice(-config.maxStoredLogs)));
  } catch {
    // Storage lleno o no disponible — ignorar
  }
}

function formatOutput(entry: LogEntry): string {
  const timestamp = config.includeTimestamp ? `[${entry.timestamp}] ` : "";
  const level = entry.level.padEnd(5);
  const module = entry.module.padEnd(12);
  let output = `${timestamp}${level} | ${module} | ${entry.message}`;

  if (entry.data !== undefined) {
    output += ` ${JSON.stringify(entry.data)}`;
  }

  if (entry.stack && config.includeStackTrace) {
    output += `\n${entry.stack}`;
  }

  return output;
}

// ── FUNCIONES DE LOGGING ────────────────────────────────────────────────────

function debug(module: string, message: string, data?: unknown): void {
  if (!shouldLog("DEBUG", module)) return;
  const entry: LogEntry = {
    timestamp: formatTimestamp(),
    level: "DEBUG",
    module,
    message,
    data,
  };
  if (config.outputToConsole) {
    console.debug(formatOutput(entry));
  }
  saveToStorage(entry);
}

function info(module: string, message: string, data?: unknown): void {
  if (!shouldLog("INFO", module)) return;
  const entry: LogEntry = {
    timestamp: formatTimestamp(),
    level: "INFO",
    module,
    message,
    data,
  };
  if (config.outputToConsole) {
    console.info(formatOutput(entry));
  }
  saveToStorage(entry);
}

function warn(module: string, message: string, data?: unknown): void {
  if (!shouldLog("WARN", module)) return;
  const entry: LogEntry = {
    timestamp: formatTimestamp(),
    level: "WARN",
    module,
    message,
    data,
  };
  if (config.outputToConsole) {
    console.warn(formatOutput(entry));
  }
  saveToStorage(entry);
}

function error(module: string, message: string, data?: unknown): void {
  if (!shouldLog("ERROR", module)) return;

  const stack = config.includeStackTrace ? new Error().stack : undefined;
  const entry: LogEntry = {
    timestamp: formatTimestamp(),
    level: "ERROR",
    module,
    message,
    data,
    stack,
  };
  if (config.outputToConsole) {
    console.error(formatOutput(entry));
  }
  saveToStorage(entry);
}

// ── FUNCIONES DE CONFIGURACIÓN ──────────────────────────────────────────────

function setLevel(level: LogLevel): void {
  config.level = level;
}

function setEnabledModules(modules: string[] | "*"): void {
  config.enabledModules = modules;
}

function enableAllModules(): void {
  config.enabledModules = "*";
}

function disableAllModules(): void {
  config.enabledModules = [];
}

function getStoredLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(config.storageKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function clearStoredLogs(): void {
  try {
    localStorage.removeItem(config.storageKey);
    logBuffer.length = 0;
  } catch { /* noop */ }
}

function getConfig(): LogConfig {
  return { ...config };
}

function setConfig(newConfig: Partial<LogConfig>): void {
  config = { ...config, ...newConfig };
}

// ── EXPORT ──────────────────────────────────────────────────────────────────

export const logger = {
  debug,
  info,
  warn,
  error,
  setLevel,
  setEnabledModules,
  enableAllModules,
  disableAllModules,
  getStoredLogs,
  clearStoredLogs,
  getConfig,
  setConfig,
};

// ── MÓDULOS PREDEFINIDOS ───────────────────────────────────────────────────
export const LOG_MODULES = {
  ENGINE: "Olympus",
  KELLY: "Kelly",
  HRP: "HRP",
  BL: "BlackLitterman",
  CEWS: "CEWS",
  REGIME: "Regime",
  VOLATILITY: "VolTarget",
  REBALANCER: "Rebalancer",
  STORAGE: "Storage",
  API: "API",
  BACKTEST: "Backtest",
  SUPABASE: "Supabase",
} as const;