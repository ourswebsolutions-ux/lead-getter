#!/usr/bin/env bash
# Installs or updates the Lead Finder licence server on the machine that hosts
# subscription.axorawebsolutions.com (PM2 + nginx, like the website).
#   bash install.sh            (first time and for every update)
# APP_DIR: where to keep the code (default /opt/lead-getter).
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/lead-getter}"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("Node.js 22.13 or newer is needed (built-in node:sqlite); this is "+process.version+". Install it (e.g. nvm install 22) and run again."); process.exit(1) }'
command -v pm2 >/dev/null || { echo "PM2 is needed: npm install -g pm2"; exit 1; }

if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone https://github.com/ourswebsolutions-ux/lead-getter.git "$APP_DIR"; fi
cd "$APP_DIR/server"
npm ci --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env && chmod 600 .env
  echo
  echo "Created $APP_DIR/server/.env. Fill it in (copy the values from server/.env on your computer, then set:"
  echo "  PUBLIC_BASE_URL=https://subscription.axorawebsolutions.com/lead-getter"
  echo "  HOST=127.0.0.1  PORT=8787  DATA_DIR=/var/lib/lead-getter"
  echo "  SUBSCRIPTION_API_URL=http://127.0.0.1:3060/api/v1   (the website, on this machine)"
  echo ") and run this script again."
  exit 1
fi

pm2 startOrReload deploy/ecosystem.config.js --update-env
pm2 save
PORT="$(grep -E '^PORT=' .env | cut -d= -f2 || true)"
for i in $(seq 20); do curl -fsS "http://127.0.0.1:${PORT:-8787}/lead-getter/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:${PORT:-8787}/lead-getter/health" && echo "  <- licence server is running" || { echo "The licence server did not start: pm2 logs lead-getter-licence"; exit 1; }
echo
echo "If not done yet: add deploy/nginx-lead-getter.conf to the website's nginx server block and reload nginx."
echo "Then, from any computer with the Lead Finder repository: npm run check:licence"
