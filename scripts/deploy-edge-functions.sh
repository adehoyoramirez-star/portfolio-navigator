
# OLYMPUS CAPITAL - Deploy Edge Functions
# Uso: bash scripts/deploy-edge-functions.sh
supabase functions deploy yahoo-finance --no-verify-jwt
supabase functions deploy fred-data --no-verify-jwt
supabase functions deploy crypto-signals --no-verify-jwt
supabase functions deploy glassnode-onchain --no-verify-jwt
supabase functions deploy ai-intelligence --no-verify-jwt
supabase functions deploy telegram-alerts --no-verify-jwt
supabase functions deploy tactical-scan --no-verify-jwt
echo 'All 7 functions deployed!'
