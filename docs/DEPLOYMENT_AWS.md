# AWS EC2 Ubuntu 24.04 LTS Deployment Guide (`DEPLOYMENT_AWS.md`)

> **Important Operational Requirement**: The AWS EC2 instance must remain in the **Running** state for the Telegram Bot and WhatsApp Web socket connections to stay active.

---

## 1. Provision AWS EC2 Instance

- **AMI**: Ubuntu Server 24.04 LTS (HVM), SSD Volume Type (`t3.small` or `t3.medium` recommended).
- **Storage**: Enable **EBS Encryption** on the root volume (minimum 16 GB gp3).
- **Security Group**:
  - **Inbound**: Allow SSH (`TCP 22`) strictly from your administrative IP address. **No public inbound HTTP/HTTPS ports are required** for the standalone Telegram Bot daemon because `grammY` uses outbound long-polling and `athanasia-baileys` uses outbound WebSockets.
  - **Outbound**: Allow `TCP 443` (HTTPS/WSS to `api.telegram.org`, `web.whatsapp.com`, `github.com`, and `registry.npmjs.org`).

---

## 2. Install Runtime & Clone Project

> **Note on `athanasia-baileys`**: This project uses `athanasia-baileys` (`github:AthanasiaCMD/athanasia-baileys#2dce999d419dfc73afd86c0a478963e04aac41bc`, v1.0.0), which enforces Node.js `>=20.0.0` via its `preinstall` check and fetches `github:AthanasiaCMD/libsignal-node` via `git`. Ensure `git` is installed on the EC2 instance before running `npm install`.

```bash
ssh ubuntu@<YOUR_EC2_PUBLIC_IP>

# Install Node.js 22 LTS and Git (required for athanasia-baileys GitHub dependency resolution)
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl git ca-certificates build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Prepare directory
sudo mkdir -p /opt/whatsapp-telegram-bot
sudo chown ubuntu:ubuntu /opt/whatsapp-telegram-bot
git clone <YOUR_GITHUB_REPO_URL> /opt/whatsapp-telegram-bot
cd /opt/whatsapp-telegram-bot

# Run setup (installs athanasia-baileys from GitHub, sets 0700 permissions, runs tests)
chmod +x scripts/setup.sh scripts/health-check.sh
./scripts/setup.sh
```

---

## 3. Configure Secrets Safely (Without Polluting Shell History)

```bash
nano /opt/whatsapp-telegram-bot/.env
chmod 600 /opt/whatsapp-telegram-bot/.env
```

Set:
```ini
NODE_ENV=production
TELEGRAM_BOT_TOKEN=<your_botfather_token>
TELEGRAM_ADMIN_ID=<your_numeric_telegram_id>
DATABASE_PATH=/opt/whatsapp-telegram-bot/data/app.sqlite
WHATSAPP_AUTH_DIR=/opt/whatsapp-telegram-bot/data/whatsapp-sessions
TEMP_UPLOAD_DIR=/opt/whatsapp-telegram-bot/data/tmp
LOG_LEVEL=info
MAX_CONCURRENT_TASKS=3
TASK_TIMEOUT_MS=120000
MAX_UPLOAD_SIZE_MB=20
```

---

## 4. Configure and Start `systemd` Service

```bash
sudo cp /opt/whatsapp-telegram-bot/systemd/whatsapp-telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-telegram-bot.service
sudo systemctl start whatsapp-telegram-bot.service
```

### Check Service Status & Logs

```bash
sudo systemctl status whatsapp-telegram-bot.service
sudo journalctl -u whatsapp-telegram-bot.service -f -n 100
./scripts/health-check.sh
```

---

## 5. Application Update, Backup, Restore & Safe Shutdown

### Safe Update Procedure
```bash
cd /opt/whatsapp-telegram-bot
sudo systemctl stop whatsapp-telegram-bot.service
git pull origin main
npm install
npm test
sudo systemctl start whatsapp-telegram-bot.service
```

### Backup Procedure
```bash
sudo systemctl stop whatsapp-telegram-bot.service
tar -czf ~/wa-bot-backup-$(date +%F).tar.gz -C /opt/whatsapp-telegram-bot data
chmod 600 ~/wa-bot-backup-*.tar.gz
sudo systemctl start whatsapp-telegram-bot.service
```

### Restore Procedure
```bash
sudo systemctl stop whatsapp-telegram-bot.service
tar -xzf ~/wa-bot-backup-YYYY-MM-DD.tar.gz -C /opt/whatsapp-telegram-bot
chmod -R 700 /opt/whatsapp-telegram-bot/data
sudo systemctl start whatsapp-telegram-bot.service
```
