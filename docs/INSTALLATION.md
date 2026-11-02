# Installation Guide (`INSTALLATION.md`)

## System Requirements

- **Operating System**: Ubuntu 24.04 LTS (or compatible Linux distribution)
- **Node.js**: **v22.13.0+ LTS** required (uses Node's built-in `node:sqlite` engine and `@hiroosy/baileys-lite@0.3.6`)
- **FFmpeg**: `ffmpeg` and `ffprobe` required for real-time H.264/Opus VoIP video call media pipeline (`@hiroosy/baileys-lite/voip`)
- **Disk Space**: Minimum 1 GB free for SQLite WAL files, isolated WhatsApp multi-file auth directories, and temporary media uploads.

---

## Step-by-Step Installation

### 1. Install Node.js 22 LTS & Git on Ubuntu 24.04 LTS

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl git ca-certificates gnupg build-essential ffmpeg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # Verify v22.13.0+ LTS (required for built-in node:sqlite)
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
1. Verifies Node.js >= 22.13.0 LTS and built-in `node:sqlite`.
2. Creates `./data/whatsapp-sessions` and `./data/tmp` with `0700` permissions.
3. Creates `.env` from `.env.example` with `0600` permissions.
4. Installs pinned dependencies (including `@hiroosy/baileys-lite@0.3.6` from npm) and executes the automated unit & integration test suites.

### 4. Configure Environment Variables

Edit `.env` (`nano .env`) and provide your real `TELEGRAM_BOT_TOKEN` and numeric `TELEGRAM_ADMIN_ID` (see `docs/CONFIGURATION.md`).

### 5. Start the Telegram Bot Daemon

```bash
npm run bot:start
```
