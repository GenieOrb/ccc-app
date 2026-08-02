#!/usr/bin/env bash
set -e

echo "============================================================"
echo "    CANARY E2E AUDIT - PREVIEW 3 MEMES"
echo "============================================================"

# This script assumes that the Next.js server is already running and listening,
# or it will start one if needed (for CI). In this environment, we just execute the mjs.

node scripts/audit-meme-preview-e2e.mjs

echo "============================================================"
echo "    AUDIT COMPLETED SUCCESSFULLY"
echo "============================================================"
