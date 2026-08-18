#!/usr/bin/env bash
# ============================================================
# Olympus — Production Gate G1 (LOCAL, pre-push)
# Typecheck + tests (bloqueantes) + lint (report-only, deuda pre-existente).
# Saltar puntualmente con: git push --no-verify
# ============================================================
set -e

echo "▶ G1 typecheck (tsc --noEmit)..."
npm run typecheck

echo "▶ G1 tests (vitest run)..."
npm test

echo "▶ lint (report-only — deuda pre-existente):"
npm run lint || echo "⚠️  lint tiene errores pre-existentes (no bloqueante por ahora)"

echo "✅ Pre-push gate superado"
