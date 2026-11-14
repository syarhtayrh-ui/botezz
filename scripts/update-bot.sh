#!/usr/bin/env bash
set -euo pipefail

echo "================================================================"
echo "🚀 Botezz Safe Updater & Single-Instance Launcher (Ubuntu EC2)"
echo "================================================================"

# 1. الانتقال إلى مجلد البوت تلقائياً
PROJECT_DIR="${BOTEZZ_DIR:-$HOME/botezz}"
if [ -f "./package.json" ] && [ -d "./src" ]; then
  PROJECT_DIR="$(pwd)"
fi
cd "$PROJECT_DIR"
echo "📂 مجلد المشروع النشط: $PROJECT_DIR"

# 2. حفظ نسخة احتياطية فورية وآمنة لملف .env قبل أي عملية
BACKUP_DIR="$HOME/botezz-backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
ENV_TMP_BACKUP="/tmp/.botezz_env_backup_$$"

if [ -f "$PROJECT_DIR/.env" ]; then
  cp -p "$PROJECT_DIR/.env" "$ENV_TMP_BACKUP"
  cp -p "$PROJECT_DIR/.env" "$BACKUP_DIR/.env.backup_$TIMESTAMP"
  chmod 600 "$ENV_TMP_BACKUP" "$BACKUP_DIR/.env.backup_$TIMESTAMP"
  echo "✅ تم حفظ نسخة احتياطية آمنة من ملف .env المحلي."
elif ls -t "$BACKUP_DIR"/.env.backup_* >/dev/null 2>&1; then
  LATEST_ENV="$(ls -t "$BACKUP_DIR"/.env.backup_* | head -n 1)"
  cp -p "$LATEST_ENV" "$ENV_TMP_BACKUP"
  echo "✅ تم استرجاع أحدث نسخة احتياطية لملف .env من $LATEST_ENV"
elif [ -f "/opt/whatsapp-telegram-bot/.env" ]; then
  cp -p "/opt/whatsapp-telegram-bot/.env" "$ENV_TMP_BACKUP"
  echo "✅ تم استرجاع ملف .env من /opt/whatsapp-telegram-bot/.env"
fi

# 3. إيقاف وقتل جميع النسخ المكررة (سواء تحت المستخدم ubuntu أو root أو systemd أو screen)
echo "🛑 إيقاف وقتل جميع العمليات القديمة والمكررة للبوت..."
sudo systemctl stop whatsapp-telegram-bot.service 2>/dev/null || true
sudo systemctl disable whatsapp-telegram-bot.service 2>/dev/null || true
sudo systemctl stop botezz.service 2>/dev/null || true
sudo systemctl disable botezz.service 2>/dev/null || true
pm2 kill 2>/dev/null || true
sudo pm2 kill 2>/dev/null || true
sudo pkill -9 -f "src/app.ts" 2>/dev/null || true
sudo pkill -9 -f "whatsapp-telegram-bot" 2>/dev/null || true
sudo pkill -9 -f "next-server" 2>/dev/null || true
sleep 2

# 4. تحديث الكود من Git مع الحفاظ على .env ومجلد data/
if [ -d "$PROJECT_DIR/.git" ]; then
  echo "🔄 جاري جلب أحدث التحديثات من Git..."
  git fetch --all --prune
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  if [ "$CURRENT_BRANCH" = "HEAD" ] || [ -z "$CURRENT_BRANCH" ]; then
    CURRENT_BRANCH="main"
  fi
  git reset --hard "origin/$CURRENT_BRANCH" || git reset --hard origin/main
  git clean -fd -e .env -e ".env.*" -e "ecosystem.config.*" -e "data/" -e "data/**"
  echo "✅ تم تحديث الكود البرمجي بنجاح."
fi

# 5. استعادة ملف .env المحلي وتنظيفه واستيراده
if [ -f "$ENV_TMP_BACKUP" ]; then
  cp -p "$ENV_TMP_BACKUP" "$PROJECT_DIR/.env"
  rm -f "$ENV_TMP_BACKUP"
fi

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "❌ خطأ: ملف .env غير موجود في $PROJECT_DIR/.env!"
  exit 1
fi

sed -i 's/\r$//' "$PROJECT_DIR/.env"
chmod 600 "$PROJECT_DIR/.env"

set -a
# shellcheck disable=SC1091
source "$PROJECT_DIR/.env"
set +a

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_ADMIN_ID:-}" ]; then
  echo "❌ خطأ: TELEGRAM_BOT_TOKEN أو TELEGRAM_ADMIN_ID فارغ داخل $PROJECT_DIR/.env!"
  exit 1
fi
echo "✅ تم التحقق من استيراد .env بنجاح (TELEGRAM_ADMIN_ID=$TELEGRAM_ADMIN_ID)"

# 6. التأكد من صلاحيات مجلدات البيانات والجلسات
mkdir -p ./data/whatsapp-sessions ./data/tmp ./data/recordings ./data/forensics
chmod 700 ./data ./data/whatsapp-sessions ./data/tmp ./data/recordings ./data/forensics

# 7. تثبيت الحزم
echo "📦 جاري تحديث الحزم البرمجية..."
npm install --no-audit --no-fund

# 8. إنشاء ملف ecosystem.config.cjs يقرأ .env مباشرة ويمرره لعملية Node لمنع أي فقدان للمتغيرات داخل PM2
cat > "$PROJECT_DIR/ecosystem.config.cjs" << 'EOF'
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.resolve(__dirname, '.env');
const parsedEnv = {
  NODE_ENV: 'production',
  NODE_OPTIONS: `--env-file=${envPath} --no-warnings`,
};

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    let val = cleaned.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const cIdx = val.indexOf(' #');
      if (cIdx !== -1) val = val.slice(0, cIdx).trim();
    }
    if (key && val !== '') {
      parsedEnv[key] = val;
    }
  }
}

module.exports = {
  apps: [
    {
      name: 'botezz',
      cwd: __dirname,
      script: './node_modules/tsx/dist/cli.mjs',
      args: 'src/app.ts',
      node_args: `--env-file=${envPath} --no-warnings`,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 15000,
      env: parsedEnv,
    },
  ],
};
EOF

# 9. مسح السجلات القديمة وتشغيل نسخة واحدة نظيفة فقط عبر PM2
echo "🚀 جاري تشغيل نسخة وحيدة نظيفة من البوت عبر PM2..."
pm2 flush 2>/dev/null || true
pm2 start "$PROJECT_DIR/ecosystem.config.cjs" --update-env
pm2 save
sleep 4
pm2 status
pm2 logs botezz --lines 25 --nostream
