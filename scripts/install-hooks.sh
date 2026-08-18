#!/usr/bin/env bash
# ============================================================
# Olympus — instala el hook pre-push local.
# Copia scripts/pre-push.sh a .git/hooks/pre-push.
# ============================================================
set -e
cp "$(dirname "$0")/pre-push.sh" .git/hooks/pre-push
chmod +x .git/hooks/pre-push
echo "✅ Hook pre-push instalado. Para saltarlo puntualmente: git push --no-verify"
