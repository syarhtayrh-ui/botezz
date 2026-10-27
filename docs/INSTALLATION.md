# Installation Guide (`INSTALLATION.md`)

## System Requirements

- **Operating System**: Ubuntu 24.04 LTS (or compatible Linux distribution)
- **Node.js**: v20.0.0+ required by `athanasia-baileys` (`engine-requirements.js`), **v22.x LTS** recommended (uses Node's built-in `node:sqlite` engine)
- **Git**: 2.34+ (**Required** during `npm install` because `athanasia-baileys` and its `libsignal` dependency are fetched directly from GitHub: `github:AthanasiaCMD/athanasia-baileys#2dce999d419dfc73afd86c0a478963e04aac41bc` and `github:AthanasiaCMD/libsignal-node`)
- **Disk Space**: Minimum 1 GB free for SQLite WAL files, isolated WhatsApp multi-file auth directories, and temporary media uploads.

---

## Step-by-Step Installation

### 1. Install Node.js 22 LTS & Git on Ubuntu 24.04 LTS

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl git ca-certificates gnupg build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # Verify v22.x (must be >= 20.0.0 for athanasia-baileys)
git --version
npm -v
```

### 2. Clone the Repository

```bash
sudo mkdir -p /opt/whatsapp-telegram-bot
sudo chown "$USER:$USER" /opt/whatsapp-telegram-bot
git clone https://github.com/your-org/whatsapp-telegram-bot.git /opt/whatsapp-telegram-bot
cd /opt/whatsapp-telegram-bot
```

### 3. Run the Automated Setup Script

```bash
chmod +x scripts/setup.sh scripts/health-check.sh
./scripts/setup.sh
```

This script:
1. Verifies Node.js 20+/22+.
2. Creates `./data/whatsapp-sessions` and `./data/tmp` with `0700` permissions.
3. Creates `.env` from `.env.example` with `0600` permissions.
4. Installs pinned dependencies (including `athanasia-baileys@1.0.0` from GitHub) and executes the automated unit & integration test suites.

### 4. Configure Environment Variables

Edit `.env` (`nano .env`) and provide your real `TELEGRAM_BOT_TOKEN` and numeric `TELEGRAM_ADMIN_ID` (see `docs/CONFIGURATION.md`).

### 5. Start the Telegram Bot Daemon

```bash
npm run bot:start
```
