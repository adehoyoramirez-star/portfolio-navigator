// ═══════════════════════════════════════════════════════════════════════
// HENDE FUND — Supabase Singleton Client
// AUDIT-CLEAN v5 — FIX-SUPA-01
//
// PROBLEMA RAÍZ DE LOS DOS ERRORES EN CONSOLA:
//
//   ERROR 1: "Multiple GoTrueClient instances detected in the same browser context"
//   CAUSA:   Existían 3 archivos que llamaban createClient() de forma independiente:
//              - src/dashboard/supabaseClient.ts       (singleton correcto)
//              - src/integrations/supabase/client.ts   (createClient() desnudo, sin singleton)
//              - src/supabaseClient.ts                 (createClient() desnudo, sin singleton)
//            marketData.ts y decisionLog.ts importaban desde @/integrations/supabase/client,
//            creando una segunda instancia con la misma storage key
//            ("sb-<projectRef>-auth-token").
//
//   ERROR 2: ReferenceError: Cannot access 'tx' before initialization
//   CAUSA:   'tx' es el nombre minificado de una variable interna de GoTrueClient
//            (lockManager transaction). Cuando dos instancias comparten la misma
//            storage key y ambas intentan adquirir un lock de BroadcastChannel
//            simultáneamente, la segunda instancia accede al objeto 'tx' antes de
//            que la primera lo haya inicializado → TDZ (Temporal Dead Zone).
//            Es decir: el ERROR 2 es consecuencia directa del ERROR 1.
//
// SOLUCIÓN: Un único createClient() en este archivo. Todos los demás módulos
//           importan desde aquí. Los archivos @/integrations/supabase/client.ts
//           y src/supabaseClient.ts (si existe) re-exportan desde este singleton.
// ═══════════════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Faltan variables de entorno VITE_SUPABASE_URL y/o VITE_SUPABASE_ANON_KEY. ' +
    'Crea un archivo .env.local en la raíz del proyecto con esas variables.'
  );
}

// Patrón singleton con globalThis para garantizar una única instancia incluso
// en entornos con HMR (Vite hot-reload) o múltiples chunks que importan este módulo.
declare global {
  // eslint-disable-next-line no-var
  var __supabaseClient: SupabaseClient | undefined;
}

export const supabase: SupabaseClient =
  globalThis.__supabaseClient ??
  (globalThis.__supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      // storageKey explícito: evita colisiones si el mismo proyecto tiene varios
      // entornos (staging/prod) abiertos en pestañas distintas del mismo navegador.
      storageKey: `sb-olympus-auth-${supabaseUrl.split('.')[0].split('//')[1]}`,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }));
