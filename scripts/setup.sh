#!/usr/bin/env bash
set -euo pipefail

echo "=== WhatsApp Multi-Session Telegram Control System — Setup Script ==="

# 1. Verify Node.js >= 22.13.0 LTS and built-in node:sqlite are available
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Please install Node.js >= 22.13.0 LTS first."
  exit 1
fi

NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node.js >= 22.13.0 LTS is required for built-in node:sqlite (found $(node -v))."
  exit 1
fi

if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "ERROR: Built-in 'node:sqlite' module is not available in $(node -v). Please upgrade to Node.js >= 22.13.0 LTS."
  exit 1
fi

# 2. Create isolated data directories with least-privilege permissions (0700)
mkdir -p ./data/whatsapp-sessions ./data/tmp
chmod 700 ./data ./data/whatsapp-sessions ./data/tmp

# 3. Copy .env.example to .env if not already present
if [ ! -f ./.env ]; then
  cp ./.env.example ./.env
  chmod 600 ./.env
  echo "Created .env from .env.example (mode 0600). Please populate TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID."
else
  chmod 600 ./.env
  echo ".env already exists (verified mode 0600)."
fi

# 4. Install dependencies and run tests
npm install
npm test

echo "=== Setup completed successfully ==="
