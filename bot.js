const { Telegraf } = require('telegraf');
const browser = require('./engine/browser');
const winston = require('winston');
require('dotenv').config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Register the alert callback so the browser can send messages back
browser.setAlertCallback((msg) => {
  // Find a way to send this to the specific user who started the session
  // For simplicity, we can store the last chatId
  if (global.lastChatId) {
    bot.telegram.sendMessage(global.lastChatId, msg);
  }
});

bot.start((ctx) => {
  ctx.reply(`Miva Bot Started! 🚀

Goal 1: Move courses to >70% progress.
Goal 2: Handle assessments (Pre, Mid, Post, End).
Goal 3: Skip videos/PDFs/materials.
Goal 4: Alert for manual tasks (uploads/downloads).

Available commands:
/take [Course Name] - Starts the automation for the course.
/status - Get current session status.
/stop - Stop all running processes.`);
});

bot.command('take', async (ctx) => {
  const courseName = ctx.message.text.replace('/take', '').trim();
  if (!courseName) {
    return ctx.reply('Please provide the course name. Example: /take ACC 101');
  }

  global.lastChatId = ctx.chat.id;
  ctx.reply(`Starting automation for "${courseName}"...`);
  
  let started = false;
  try {
    await browser.start();
    started = true;
    await browser.login();
    await browser.goToLMS();
    await browser.handleCourse(courseName);
    ctx.reply(`✅ Successfully completed "${courseName}" activities!`);
  } catch (error) {
    if (error.message.includes('already in progress')) {
      ctx.reply(`⚠️ ${error.message}`);
    } else {
      logger.error(`Automation Error for ${courseName}:`, { 
        message: error.message, 
        stack: error.stack,
        url: browser.page ? browser.page.url() : 'N/A' 
      });
      ctx.reply(`❌ Error while taking course: ${error.message}`);
    }
  } finally {
    if (started) {
      await browser.stop();
    }
  }
});

bot.command('status', (ctx) => {
  ctx.reply('Bot is currently active and processing activities.');
});

bot.command('stop', async (ctx) => {
  await browser.stop();
  ctx.reply('Bot stopped.');
});

bot.launch().then(() => {
  logger.info('Telegram Bot started');
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { message: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason: reason instanceof Error ? reason.stack : reason });
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
