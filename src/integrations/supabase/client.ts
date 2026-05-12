// ═══════════════════════════════════════════════════════════════════════
// src/integrations/supabase/client.ts
// FIX-SUPA-01: Re-exporta desde el singleton canónico.
//
// ANTES: llamaba createClient() de forma independiente → segunda instancia
//        de GoTrueClient → warning + ReferenceError 'tx' en runtime.
//
// AHORA: re-exporta el cliente ya creado en src/dashboard/supabaseClient.ts.
//        No hay ningún createClient() aquí. Todos los archivos que importaban
//        desde esta ruta (marketData.ts, decisionLog.ts) siguen funcionando
//        sin cambiar sus imports.
// ═══════════════════════════════════════════════════════════════════════

export { supabase } from '@/dashboard/supabaseClient';