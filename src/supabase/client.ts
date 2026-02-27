// src/integrations/supabase/client.ts
// Mock de Supabase para que no falle la compilación
export const supabase = {
  from: (table: string) => ({
    select: () => Promise.resolve({ data: null, error: null }),
    insert: () => Promise.resolve({ data: null, error: null }),
    update: () => Promise.resolve({ data: null, error: null }),
    delete: () => Promise.resolve({ data: null, error: null }),
  }),
};