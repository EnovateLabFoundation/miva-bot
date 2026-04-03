const engine = require('./engine/browser');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [TESTBENCH] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/testbench.log' })
  ]
});

async function runAutonomousTest(courseUrlOrName) {
    logger.info(`Starting Autonomous Test for: ${courseUrlOrName}`);
    
    let started = false;
    try {
        await engine.start();
        started = true;
        
        await engine.login();
        await engine.goToLMS();
        
        // V5.8: Self-Healing Loop
        // We will run handleCourse and catch any critical failures
        // This will trigger analyzeFailure and save screenshots for Antigravity
        await engine.handleCourse(courseUrlOrName);
        
        logger.info('Test Bench Cycle Complete. Course automated.');
    } catch (error) {
        logger.error(`Critical Test Bench Failure: ${error.message}`);
        if (engine.page) {
            await engine.analyzeFailure('TESTBENCH_LOOP', error);
        }
    } finally {
        if (started) {
            await engine.stop();
        }
    }
}

// Target: GST 121 (Use of Library, Study Skills and ICT)
const TARGET = 'https://lms.miva.university/course/view.php?id=444';

runAutonomousTest(TARGET).catch(err => {
    console.error('Fatal Test Bench Error:', err);
});
