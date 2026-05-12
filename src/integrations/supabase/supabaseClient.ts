// ═══════════════════════════════════════════════════════════════════════
// HENDE FUND — Supabase Singleton Client
// FIX-SUPA-02: Singleton + lock override para eliminar TDZ 'tx'
//
// ERRORES RESUELTOS:
//   1. "Multiple GoTrueClient instances" → un solo createClient() en toda la app
//   2. "Cannot access 'tx' before initialization" → dos causas:
//      a) Múltiples instancias compartiendo la misma storageKey (resuelto con singleton)
//      b) Bug en supabase-js 2.39+ con Web Locks API en contextos con HMR/Vite
//         (resuelto con lock override que serializa el acceso)
//
// REGLA: Ningún otro archivo llama createClient(). Todos importan { supabase }
//        desde este archivo o desde @/integrations/supabase/client (que re-exporta aquí).
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

declare global {
  // eslint-disable-next-line no-var
  var __supabaseClient: SupabaseClient | undefined;
}

// FIX-SUPA-02b: lock override serializado con una Promise chain.
// supabase-js 2.39+ usa Web Locks API internamente para sincronizar el estado
// de auth entre pestañas. En entornos con Vite HMR o múltiples chunks que
// inicializan simultáneamente, dos gorutinas pueden intentar acceder a la
// variable interna 'tx' antes de que esté inicializada → TDZ.
// Reemplazamos el lock por una cola de Promises que garantiza acceso secuencial
// sin depender de la Web Locks API del navegador.
let _lockQueue = Promise.resolve();
const acquireLock = <T>(
  _name: string,
  _timeout: number,
  fn: () => Promise<T>
): Promise<T> => {
  const result = _lockQueue.then(() => fn());
  // Absorber errores en la cola para que no bloqueen futuras adquisiciones
  _lockQueue = result.then(
    () => {},
    () => {}
  );
  return result;
};

export const supabase: SupabaseClient =
  globalThis.__supabaseClient ??
  (globalThis.__supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession:      true,
      autoRefreshToken:    true,
      detectSessionInUrl:  true,
      // storageKey: usar el valor por defecto (sb-<ref>-auth-token)
      // NO cambiar este valor: cambiar la key invalida sesiones existentes
      // y causa que el BroadcastChannel emita eventos de logout a otras pestañas.
      lock: acquireLock,
    },
  }));