// ===============================================
// ARCHIVO: src/integrations/supabase/client.ts
// FIX: Configuración correcta del cliente Supabase
// ===============================================

import { createClient } from '@supabase/supabase-js';

// ====== CONFIGURACIÓN CORRECTA ======
// Las variables de entorno deben estar en .env o .env.local

// Para Vite/React (detecta automáticamente)
const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;

// O para Next.js (comenta lo de arriba y descomenta esto):
// const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
// const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ====== VALIDACIÓN ======
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ [Supabase] Variables de entorno faltantes:');
  console.error('   VITE_SUPABASE_URL:', supabaseUrl ? '✅' : '❌ FALTA');
  console.error('   VITE_SUPABASE_ANON_KEY:', supabaseAnonKey ? '✅' : '❌ FALTA');
  console.error('');
  console.error('Solución:');
  console.error('1. Crea archivo .env.local en la raíz del proyecto');
  console.error('2. Añade estas variables (obtén valores de Supabase Dashboard → Settings → API):');
  console.error('   VITE_SUPABASE_URL=https://[TU-PROJECT-REF].supabase.co');
  console.error('   VITE_SUPABASE_ANON_KEY=eyJhbG...[tu-anon-key]');
  console.error('3. Reinicia el dev server (npm run dev)');
  console.error('');
  
  throw new Error('Supabase configuration missing. Check .env.local file.');
}

// Validar que la URL NO sea claude.ai (error común detectado)
if (supabaseUrl.includes('claude.ai')) {
  console.error('❌ [Supabase] URL INCORRECTA detectada:', supabaseUrl);
  console.error('   La URL no puede ser claude.ai');
  console.error('   Debe ser: https://[TU-PROJECT-REF].supabase.co');
  console.error('   Verifica tu archivo .env.local');
  
  throw new Error('Invalid Supabase URL. Must be https://[project-ref].supabase.co');
}

// Log de configuración en desarrollo (opcional, útil para debugging)
if (import.meta.env?.DEV || process.env.NODE_ENV === 'development') {
  console.log('[Supabase] Client initialized with URL:', supabaseUrl);
}

// ====== CREAR CLIENTE ======
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// ====== EXPORT PARA DEBUGGING ======
// Útil para verificar configuración desde la consola
if (typeof window !== 'undefined') {
  (window as any).__SUPABASE_CONFIG__ = {
    url: supabaseUrl,
    // NO expongas la anon key completa en producción
    hasAnonKey: !!supabaseAnonKey,
  };
}
