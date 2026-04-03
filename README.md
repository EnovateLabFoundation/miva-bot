# Miva LMS Automation Bot 🚀

This bot autonomously handles Miva University LMS activities including navigation, videos, assessments, and evaluations.

## 🛠 Prerequisites

- **Node.js**: (v18 or higher recommended)
- **Playwright**: For browser automation (`npx playwright install chromium`)
- **Telegram Token**: Create one via [@BotFather](https://t.me/botfather)

## 🚀 Running the Bot (Manual)

To run the bot once:
```bash
node bot.js
```

## 🔋 Running the Bot 24/7 (Recommended)

To ensure the bot stays online even after a crash or your computer restarts, we recommend using **PM2**.

### 1. Install PM2
```bash
npm install -g pm2
```

### 2. Start the Bot with PM2
```bash
pm2 start bot.js --name miva-bot
```

### 3. Manage the Bot
- **Check Status**: `pm2 status miva-bot`
- **View Live Logs**: `pm2 logs miva-bot`
- **Stop the Bot**: `pm2 stop miva-bot`
- **Restart the Bot**: `pm2 restart miva-bot`

---

## 🔒 Configuration

Edit the `.env` file to set your Miva credentials and Telegram token:
- `MIVA_EMAIL`: Your Miva student email.
- `MIVA_PASSWORD`: Your Miva student password.
- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token.
- `HEADLESS`: `true` to run without a visible browser window, `false` to watch it work.
