import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  'https://yrirandgftnuvdzatwgc.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyaXJhbmRnZnRudXZkemF0d2djIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5NTk3MDgsImV4cCI6MjA4NDUzNTcwOH0.sBqkJvkBuirvVt1fa3UpZBBradaYn_68ZZ3nmoiJXeM'
)
