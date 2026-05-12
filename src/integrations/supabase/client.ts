// FIX-SUPA-01: Re-exporta desde el singleton canónico.
// No añadir createClient() aquí. Ver src/dashboard/supabaseClient.ts
export { supabase } from '@/dashboard/supabaseClient';