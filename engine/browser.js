const { chromium } = require('playwright');
const winston = require('winston');
const llm = require('./llm');
require('dotenv').config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

class BrowserEngine {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isHeadless = process.env.HEADLESS === 'true';
    this.alertCallback = null;
    this.stuckCounter = 0;
    this.lastUrl = '';
    this.isRunning = false;
    this.lastProgressTime = Date.now();
  }

  async safeInteract(locator, action = 'click') {
    try {
      if (!this.page || this.page.isClosed()) return false;
      
      // Ensure element is attached and semi-visible
      await locator.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
      
      if (action === 'click') {
        logger.info(`SafeInteract: Performing native click on ${await locator.count()} element(s)`);
        await locator.evaluate(el => el.click());
      } else if (action === 'scroll') {
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      }
      return true;
    } catch (e) {
      logger.warn(`Safety Shield caught interaction error: ${e.message}. Re-orienting...`);
      return false;
    }
  }

  setAlertCallback(cb) {
    this.alertCallback = cb;
  }

  async smartScroll() {
    await this.page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        let distance = 100;
        let timer = setInterval(() => {
          let scrollHeight = document.body ? document.body.scrollHeight : 0;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight || scrollHeight === 0) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
  }

  async getInteractiveMap() {
    return await this.page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('a, button, [role="button"], label'));
      return elements
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
        })
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          return {
            index,
            tag: el.tagName,
            text: el.innerText.trim().substring(0, 80),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }).filter(el => el.text.length > 0 || el.tag === 'BUTTON');
    });
  }

  async withRetry(action, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await action();
      } catch (error) {
        if (i === retries - 1) throw error;
        logger.warn(`Action failed (Attempt ${i + 1}/${retries}): ${error.message}. Retrying in ${delay}ms...`);
        await this.page.waitForTimeout(delay);
        // delay *= 2; // Exponential backoff (temporarily disabled for quiz recovery)
      }
    }
  }

  async searchForNavigation() {
    // Human Instinct Logic: Prioritize Container -> Sidebar -> Footer
    
    // Zone 1: Content Container (Next Page / Continue / Finish)
    const containerNext = this.page.locator('.course-content a:has-text("Next Page"), .course-content button:has-text("Continue"), .course-content a:has-text("Continue"), .course-content button:has-text("Next page"), .course-content button:has-text("Finish attempt")').first();
    
    // Zone 2: Sidebar (Finish attempt or Question jumping)
    const sidebarFinish = this.page.locator('.block_quiz_navigation a:has-text("Finish attempt"), .block_quiz_navigation a:has-text("Submit"), .block_navigation a:has-text("Finish")').first();

    // Zone 3: Footer (Next activity)
    const footerNext = this.page.locator('.section-navigation a:has-text("Next activity"), .section-navigation a:has-text("Next Section"), .nav-links a:has-text("Next")').first();

    logger.info('Searching for navigation buttons via Zone-Aware Smart Scroll...');
    
    const zones = [containerNext, sidebarFinish, footerNext];
    
    for (let i = 0; i < 15; i++) {
       for (const [index, loc] of zones.entries()) {
        if (await loc.isVisible().catch(() => false)) {
          logger.info(`Found navigation button in Zone ${index + 1}`);
          return loc;
        }
      }

      // Check if we hit the bottom before scrolling again
      const isAtBottom = await this.page.evaluate(() => {
        if (!document.body) return true;
        return (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 50);
      });
      if (isAtBottom) {
        logger.info('Reached bottom of page. Final scan complete.');
        break;
      }

      await this.page.evaluate(() => window.scrollBy(0, 400));
      await this.page.waitForTimeout(400);
    }
    
    // Search for bold links as last resort (indicates current active navigation in Sidebar)
    const boldLink = this.page.locator('.nav-links a:has(strong, b)').last();
    if (await boldLink.isVisible()) return boldLink;

    // Scroll back to top if not found
    await this.page.evaluate(() => window.scrollTo(0, 0));
    return null;
  }

  async start() {
    if (this.isRunning) {
      throw new Error('An automation session is already in progress. Please wait for it to finish or use /stop.');
    }
    
    this.isRunning = true;
    try {
      this.browser = await chromium.launch({ headless: this.isHeadless });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
      logger.info('Browser started');
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  async login() {
    const email = process.env.MIVA_EMAIL;
    const password = process.env.MIVA_PASSWORD;

    if (!email || !password) {
      throw new Error('Miva credentials (MIVA_EMAIL and MIVA_PASSWORD) are missing in .env file.');
    }

    logger.info(`Logging in for: ${email}...`);
    try {
      await this.withRetry(async () => {
        // Use 'load' instead of 'networkidle' to avoid timeouts on background script noise
        await this.page.goto('https://sis.miva.university/login', { waitUntil: 'load', timeout: 45000 });
        
        // Wait specifically for the elements we NEED
        const emailInput = await this.page.waitForSelector('input[name="email"]', { state: 'visible', timeout: 15000 });
        await emailInput.fill(email);
        await this.page.fill('input[name="password"]', password);
        
        const loginBtn = this.page.locator('button:has-text("Login")');
        await this.safeInteract(loginBtn, 'click');
        
        logger.info('Waiting for dashboard navigation...');
        await this.page.waitForURL('**/dashboard', { timeout: 30000 });
      });
      logger.info('Login successful');
    } catch (error) {
      await this.analyzeFailure('Login failed', error);
      throw new Error(`Login failed: ${error.message}`);
    }
  }

  async goToLMS() {
    logger.info('Navigating to LMS...');
    await this.page.goto('https://sis.miva.university/courses');
    const goToClassBtn = this.page.locator(':text("Go to Class")').first();
    await goToClassBtn.waitFor({ state: 'visible', timeout: 45000 });
    
    const [newPage] = await Promise.all([
      this.context.waitForEvent('page'),
      this.safeInteract(goToClassBtn, 'click'),
    ]);
    
    this.page = newPage;
    await this.page.waitForLoadState();
    logger.info('Switched to LMS Tab');
  }

  async handleCourse(courseName) {
    if (courseName.startsWith('http')) {
      logger.info(`Navigating directly to course URL: ${courseName}`);
      await this.page.goto(courseName);
    } else {
      logger.info(`Searching for course: ${courseName}`);
      const courseCard = await this.page.locator(`div:has-text("${courseName}")`).first();
      await this.safeInteract(courseCard, 'scroll');
      const viewBtn = await courseCard.locator('a:has-text("View Course")').first();
      await this.safeInteract(viewBtn, 'click');
    }
    await this.page.waitForLoadState();

    let finished = false;
    while (!finished) {
      try {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        const progress = await this.getProgress();
        if (progress >= 70) {
          logger.info(`Goal reached: ${progress}% progress.`);
          if (this.alertCallback) this.alertCallback(`Success! Reached ${progress}% progress for ${courseName}.`);
          finished = true;
          break;
        }

        await this.ensureInActivity();
        await this.runActivityCycle();
        await this.checkForStuck();
        await this.page.waitForTimeout(1000); // Small cooldown to prevent loop spamming 
      } catch (error) {
        if (error.message.includes('context was destroyed') || error.message.includes('navigation')) {
          logger.warn('Navigation interrupted the cycle. Retrying after stabilization...');
          await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        } else {
          throw error;
        }
      }
    }
  }

  async getProgress() {
    try {
      // Look for progress bar in course landing page or activity header
      const progressElement = await this.page.locator('.progress-bar-text, .course-progress-value, .progress-text').first(); 
      if (!(await progressElement.isVisible())) return 0;
      const text = await progressElement.innerText();
      return parseInt(text.replace('%', '')) || 0;
    } catch (e) {
      return 0; 
    }
  }

  async ensureInActivity() {
    const url = this.page.url();
    if (url.includes('course/view.php')) {
      logger.info('On course landing page. Attempting to enter activities...');
      
      // Priority 1: Resume Button
      const resumeBtn = await this.page.locator('button:has-text("Resume"), a:has-text("Resume"), button:has-text("Continue"), a:has-text("Continue")').first();
      if (await resumeBtn.isVisible()) {
        logger.info('Found Resume/Continue button. Clicking...');
        await resumeBtn.scrollIntoViewIfNeeded();
        await resumeBtn.click();
        await this.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        return;
      }

      // Priority 2: Sidebar/Menu First Uncompleted Activity
      // Often in Moodle: .course-content .activity
      const firstActivity = await this.page.locator('.course-content .activity a, .section .activity a').first();
      if (await firstActivity.isVisible()) {
        logger.info('Entering first available activity from menu...');
        await firstActivity.scrollIntoViewIfNeeded();
        await firstActivity.click();
        await this.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        return;
      }

      logger.warn('Could not find immediate way to enter activity. Waiting for manual jump or automatic redirect.');
    }
  }

  async checkForStuck() {
    const currentUrl = this.page.url();
    if (currentUrl === this.lastUrl) {
      this.stuckCounter++;
    } else {
      this.stuckCounter = 0;
    }
    this.lastUrl = currentUrl;

    if (this.stuckCounter > 3) {
      logger.warn('Detected STUCK state. Re-basing to course landing page...');
      this.stuckCounter = 0;
      // Try to find the course root via breadcrumbs or re-navigate to the last known URL
      const breadcrumb = this.page.locator('.breadcrumb-item a').first();
      if (await breadcrumb.isVisible()) {
        await this.safeInteract(breadcrumb);
      } else {
        await this.page.goto(this.lastUrl).catch(() => {});
      }
    }
  }

  async runActivityCycle() {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      
      const url = this.page.url();
      const isActivity = url.includes('/mod/') || url.includes('view.php?id=') === false; 
      const pageText = await this.page.innerText('body');

      // 1. Mark Done always
      const markDone = await this.page.locator('button:has-text("Mark Done"), .btn-mark-done').first();
      if (await markDone.isVisible().catch(() => false)) {
        await this.safeInteract(markDone, 'click');
        logger.info('Clicked "Mark Done" (Safe)');
        await this.page.waitForTimeout(1500);
      }

      // 2. Alert for Uploads / Downloads
      if (pageText.includes('upload your file') || pageText.includes('download the template')) {
        if (this.alertCallback) {
          await this.alertCallback(`🚨 MANUAL ACTION REQUIRED: The course "${await this.page.title()}" requires a file upload or download. Please visit the link manually to finish this task.`);
        }
      }

      // 3. Skip Live Lessons / Office Hours - ONLY if actually in a module
      const pageTitle = await this.page.title().catch(() => '');
      const mainHeading = await this.page.locator('h1, h2, h3').first().innerText().catch(() => '');
      const shouldSkip = (pageTitle.includes('Live Lesson') || pageTitle.includes('Office Hours') || mainHeading.includes('Live Lesson') || mainHeading.includes('Office Hours'));

      if (isActivity && shouldSkip) {
        logger.info('Skipping Live Lesson / Office Hours material.');
        const nextBtn = await this.page.locator('a.next-activity-link, a[data-region="next-activity-link"], a:has-text("Next Activity")').first();
        if (await nextBtn.isVisible().catch(() => false)) {
          logger.info(`Skipping material: clicking "${await nextBtn.innerText().catch(() => 'Next')}"`);
          await this.safeInteract(nextBtn, 'click');
          return;
        }
      }

      // 3.5. Ensure we're at the bottom before searching for next
      await this.smartScroll();

      // 4. Content Handling
      const isVideoVisible = await this.page.locator('video').first().isVisible().catch(() => false);
      const isPDFVisible = await this.page.locator('iframe[src*="pdf"], embed[type="application/pdf"]').first().isVisible().catch(() => false);
      const isQuiz = (await this.page.locator('.que').count().catch(() => 0)) > 0 || (await this.page.locator('button:has-text("Attempt")').count().catch(() => 0)) > 0;

      if (isVideoVisible) {
        await this.page.evaluate(() => {
          const v = document.querySelector('video');
          if (v && v.duration) v.currentTime = v.duration - 1;
        });
        logger.info('Video skipped to end. Waiting for LMS sync...');
        await this.page.waitForTimeout(3000); // 3s buffer for LMS to register completion
      } else if (isPDFVisible) {
        await this.page.evaluate(() => {
          if (document.body) window.scrollTo(0, document.body.scrollHeight);
        });
        logger.info('Scrolled through PDF');
      } else if (isQuiz) {
        await this.handleQuiz();
      }

      // 5. Evaluation Handling
      if (pageText.includes('End of course evaluation')) {
        await this.handleEvaluation();
      }

      // 6. Next Activity / Section - Handle both standard buttons and text-based bold links with Smart Search
      const nextBtn = await this.searchForNavigation();
      if (nextBtn) {
        logger.info(`Cycle end: Navigating via found button: "${await nextBtn.innerText().catch(() => 'Next Activity')}"`);
        await this.safeInteract(nextBtn, 'click');
        await this.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      } else {
        // Fallback for Moodle: Find the text-based link with bold characters which is usually the only visible navigation link on the right.
        const rightNav = await this.page.locator('.activity-navigation a.pull-right, .nav-links a:has(strong, b)').first();
        if (await rightNav.isVisible()) {
          logger.info(`Found potential navigation link: "${await rightNav.innerText()}"`);
          await rightNav.scrollIntoViewIfNeeded();
          await rightNav.click();
          await this.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        } else {
          logger.info('Standard navigation not found. Consulting LLM for the "Smart" next step...');
          const map = await this.getInteractiveMap();
          const decision = await llm.makeDecision({
            url: this.page.url(),
            pageTitle: await this.page.title(),
            interactiveElements: map
          });
          
          if (decision) {
            logger.info(`LLM Decision: ${decision}`);
            await this.executeDecision(decision, map);
          } else {
            logger.warn('LLM failed to provide a navigation decision.');
          }
        }
      }
    } catch (error) {
      if (error.message.includes('context was destroyed') || error.message.includes('navigation')) {
        // Silently catch and let the main loop retry
        return;
      }
      throw error;
    }
  }

  async handleQuiz() {
    try {
      logger.info('Starting Assessment attempt/RE-attempt...');
      const attemptBtn = await this.page.locator('button:has-text("Answer the Questions"), button:has-text("Attempt"), button:has-text("Attempt Quiz"), button:has-text("Continue your attempt"), button:has-text("Re-attempt quiz")').first();
      if (await attemptBtn.isVisible()) {
        await attemptBtn.click();
        await this.page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      }

      let assessmentFinished = false;
      while (!assessmentFinished) {
        // Wait for question to be present
        const qLocator = this.page.locator('.que').first();
        const isSummary = await this.page.locator('h2:has-text("Summary of attempt"), .summarytable').first().isVisible();
        
        if (!(await qLocator.isVisible()) || isSummary) {
          if (isSummary) logger.info('At Quiz Summary page. Looking for final submission...');
          
          // STEP 1: Click "Submit all and finish" on Summary Page
          const finalSubmit = this.page.locator('button:has-text("Submit all and finish"), input[value="Submit all and finish"]').first();
          if (await finalSubmit.isVisible().catch(() => false)) {
            logger.info('Performing Final Submission (Step 1)...');
            await this.safeInteract(finalSubmit, 'click');
            
            // STEP 2: Handle the confirmation modal (Big Red Button again)
            logger.info('Waiting for confirmation modal...');
            const confirmBtn = this.page.locator('.moodle-dialogue-bd button:has-text("Submit all and finish"), .modal-content button:has-text("Submit all and finish")').first();
            await confirmBtn.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
            if (await confirmBtn.isVisible().catch(() => false)) {
                await this.safeInteract(confirmBtn, 'click');
                logger.info('Assessment confirmed and submitted.');
            }
          } else {
             // Fallback for summary-without-button cases
             const finish = await this.page.locator('input[value="Finish attempt..."], button:has-text("Finish attempt")').first();
             if (await finish.isVisible().catch(() => false)) {
               await this.safeInteract(finish, 'click');
               const finalConfirm = this.page.locator('button:has-text("Submit all and finish")').first();
               await this.safeInteract(finalConfirm, 'click');
             }
          }
          assessmentFinished = true;
          break;
        }

        // Multi-Question Scanning Logic (Sequential)
        const questionsOnPage = await this.page.locator('.que').all();
        logger.info(`Detected ${questionsOnPage.length} questions on this page.`);

        for (const [index, qLoc] of questionsOnPage.entries()) {
          // Check if already answered
          const isAnswered = await qLoc.evaluate(el => el.classList.contains('answered') || !el.classList.contains('notyetanswered')).catch(() => false);
          if (isAnswered) {
             logger.info(`Question ${index + 1} already answered. Skipping.`);
             continue;
          }

          // Frame the question
          logger.info(`Framing Question ${index + 1}...`);
          await qLoc.scrollIntoViewIfNeeded({ timeout: 5000 });
          
          const questionText = await qLoc.locator('.qtext').textContent(); 
          const options = await qLoc.locator('.answer div').evaluateAll(els => els.map(e => e.innerText.trim()));

          const response = await llm.solveQuiz({ question: questionText, options });
          if (response && response.answers && response.answers[0]) {
            const answer = response.answers[0].selection;
            logger.info(`LLM Selected Answer for Q${index + 1}: "${answer}"`);
            
            await this.withRetry(async () => {
              const normalizedAnswer = answer.replace(/\s+/g, ' ').trim();
              const optionLocator = qLoc.locator('label').filter({ 
                hasText: new RegExp(normalizedAnswer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') 
              }).first();
              
              try {
                await this.safeInteract(optionLocator, 'click');
                logger.info(`Q${index + 1} answered.`);
              } catch (e) {
                // Local recovery for this specific question
                const actualLabels = await qLoc.locator('label').allInnerTexts();
                const bestIndex = await llm.recoverQuizAction(answer, actualLabels);
                logger.info(`Smart Recovery for Q${index + 1}: LLM picked Index ${bestIndex}`);
                const recoveryLocator = qLoc.locator('label').nth(bestIndex);
                await this.safeInteract(recoveryLocator, 'click');
              }
            }, 2, 1000);
          }
        }

        // Navigation to next page or finish
        const nextQ = await this.page.locator('input[value="Next page"], button:has-text("Next page")').first();
        const finishAttempt = await this.page.locator('button:has-text("Finish attempt"), input[value="Finish attempt"]').first();

        if (await nextQ.isVisible()) {
          await nextQ.evaluate(el => el.click());
          await this.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        } else if (await finishAttempt.isVisible()) {
          logger.info('Finished all questions on page. Proceeding to Summary...');
          await finishAttempt.evaluate(el => el.click());
        } else {
          assessmentFinished = true;
          break;
        }
      }
    } catch (error) {
      if (error.message.includes('context was destroyed') || error.message.includes('navigation')) {
        return; 
      }
      throw error;
    }
  }

  async handleEvaluation() {
    logger.info('Handling End of Course Evaluation...');
    // Generic logic to click first option on every radio group (usually 'Very Satisfied')
    const radioGroups = await this.page.$$('.form-group');
    for (const group of radioGroups) {
      const radio = await group.$('input[type="radio"]');
      if (radio) await radio.click();
    }
    const submit = await this.page.$('button:has-text("Submit")');
    if (submit) await submit.click();
  }

  async executeDecision(decision, map) {
    try {
      // Expecting decision format: "CLICK_NEXT: Index 5" or "SCROLL_DOWN" etc.
      if (decision.includes('CLICK_NEXT') || decision.includes('CLICK')) {
        const match = decision.match(/Index (\d+)/);
        if (match) {
          const index = parseInt(match[1]);
          const element = map.find(e => e.index === index);
          if (element) {
            logger.info(`Executing LLM Click on: "${element.text}" (Index ${index})`);
            const preciseLocator = this.page.locator(`${element.tag.toLowerCase()}:has-text("${element.text}")`).first();
            await this.safeInteract(preciseLocator, 'click');
            await this.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
          }
        }
      } else if (decision.includes('SCROLL_DOWN')) {
        await this.smartScroll();
      } else if (decision.includes('MARK_DONE')) {
        const markDone = await this.page.locator('button:has-text("Mark Done"), .btn-mark-done').first();
        if (await markDone.isVisible()) {
          await markDone.scrollIntoViewIfNeeded();
          await markDone.click();
        }
      }
    } catch (e) {
      logger.error(`Failed to execute LLM decision: ${e.message}`);
    }
  }

  async analyzeFailure(context, error) {
    const url = this.page ? this.page.url() : 'N/A';
    logger.error(`[FAILURE ANALYZER] Context: ${context}. URL: ${url}. Error: ${error.message}`);
    
    try {
      // Small logic to use LLM to identify if this is a common issue
      const screenshot = await this.page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
      if (screenshot) {
        logger.info('Captured screenshot of failure for later review.');
      }
      
      const map = await this.getInteractiveMap().catch(() => []);
      const analysis = await llm.makeDecision({
        type: 'ERROR_ANALYSIS',
        context,
        errorMessage: error.message,
        url,
        interactiveElements: map
      });
      
      if (analysis) {
        logger.info(`LLM Failure Analysis: ${analysis}`);
        // If the LLM suggests a simple fix (like "CLICK_SOMETHING_ELSE"), we could attempt it here
      }
    } catch (e) {
      logger.warn(`Failure Analyzer itself failed: ${e.message}`);
    }
  }

  async stop() {
    this.isRunning = false;
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = new BrowserEngine();
