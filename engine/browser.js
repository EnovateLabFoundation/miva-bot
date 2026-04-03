const { chromium } = require('playwright');
const winston = require('winston');
const llm = require('./llm');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const MEMORY_FILE = path.join(__dirname, '..', 'memory', 'experiences.json');

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
    this.curriculumMap = [];
    this.lastRefreshTime = Date.now();
    this.currentCourseId = null;
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

  // V4: Chrome Error Detection
  async isErrorState() {
    try {
      if (!this.page || this.page.isClosed()) return true;
      const url = this.page.url();
      const title = await this.page.title().catch(() => '');
      return (url.includes('chrome-error://') || url === 'about:blank' || title.includes('Loading...'));
    } catch (e) {
      return true; // Assume error if we can't even query the page
    }
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
    
    // Zone 0: Remui Theme Navbar (High Priority)
    const navbarNext = this.page.locator('#courseNext a, .activity-navigation a:has-text("Next")').first();
    
    // Zone 1: Content Container (Bold Links / Next Page / Continue / Finish)
    const containerNext = this.page.locator('.course-content a:has(strong, b), .course-content a:has-text("Next Page"), .course-content button:has-text("Continue"), .course-content a:has-text("Continue"), .course-content button:has-text("Next page"), .course-content button:has-text("Finish attempt")').first();
    
    // Zone 2: Sidebar (Finish attempt or Question jumping)
    const sidebarFinish = this.page.locator('.block_quiz_navigation a:has-text("Finish attempt"), .block_quiz_navigation a:has-text("Submit"), .block_navigation a:has-text("Finish")').first();

    // Zone 3: Footer (Next activity / Next Section / Resume)
    const footerNext = this.page.locator('.section-navigation a:has-text("Next activity"), .section-navigation a:has-text("Next Section"), .nav-links a:has-text("Next"), a:has-text("Resume")').first();

    logger.info('Searching for navigation buttons via Zone-Aware Smart Scroll...');
    
    const zones = [navbarNext, containerNext, sidebarFinish, footerNext];
    
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
        const emailInput = await this.page.waitForSelector('input[name="email"]', { state: 'visible', timeout: 15000 }).catch(() => null);
        if (emailInput) await emailInput.fill(email);
        await this.page.fill('input[name="password"]', password);
        
        const loginBtn = this.page.locator('button:has-text("Login")');
        await this.safeInteract(loginBtn, 'click');
        
        logger.info('Waiting for dashboard navigation...');
        await this.page.waitForURL('**/dashboard', { timeout: 30000 }).catch(() => {});
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
    await goToClassBtn.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
    
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
    await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    
    // V3: Build the Curriculum Map at start
    await this.mapCurriculum();
    this.currentCourseId = this.page.url();

    let finished = false;
    while (!finished) {
      try {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
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
        
        // V3: Check for session maturity (45 minutes)
        if (Date.now() - this.lastRefreshTime > 45 * 60 * 1000) {
          await this.refreshSession();
        }
        
        await this.page.waitForTimeout(1000); 
      } catch (error) {
        if (error.message.includes('context was destroyed') || error.message.includes('navigation')) {
          logger.warn('Navigation interrupted the cycle. Retrying after stabilization...');
          await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
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
      logger.info('On course landing page. Checking for Resume priority...');
      
      // V3.2: Immediate priority on "Resume" button if available
      const resumeBtn = await this.page.locator('button:has-text("Resume"), a:has-text("Resume"), button:has-text("Continue"), a:has-text("Continue")').first();
      if (await resumeBtn.isVisible().catch(() => false)) {
        logger.info('Found primary Resume/Continue button. Entering activity...');
        await this.safeInteract(resumeBtn, 'click');
        await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
        return;
      }

      logger.info('Scanning for the first UNCOMPLETED activity (Remui Aware)...');
      
      // V5: Use more precise activity-item selector from ground-truth HTML
      const activities = await this.page.locator('.activity-item, .course-content .activity').all();
      for (const activity of activities) {
        // V5: Target specific 'complete_icon' from ground-truth HTML
        const isDone = await activity.locator('.activity-completion-indicator.complete_icon, .fa-check, .completion-info .badge-success').isVisible().catch(() => false);
        if (!isDone) {
          const link = activity.locator('a').first();
          if (await link.isVisible().catch(() => false)) {
            const label = await link.innerText().catch(() => 'Activity');
            logger.info(`Entering next task: ${label}`);
            await this.safeInteract(link, 'click');
            await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
            return;
          }
        }
      }

      // Check for bold links etc. (The Resume button logic was moved to the top of this function as a priority)
      logger.warn('Could not find first uncompleted activity. Waiting for manual jump.');
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

    if (this.stuckCounter > 5) {
      logger.warn('Detected HARD STUCK state. Clearing browser context entirely for Hard Recovery...');
      this.stuckCounter = 0;
      await this.refreshSession();
      return;
    }
    
    if (this.stuckCounter > 3) {
      logger.warn('Detected STUCK state. Re-basing to course landing page...');
      this.stuckCounter = 0;
      // Try to find the course root via breadcrumbs or re-navigate to the last known URL
      const breadcrumb = this.page.locator('.breadcrumb-item a').first();
      if (await breadcrumb.isVisible().catch(() => false)) {
        await this.safeInteract(breadcrumb);
      } else {
        await this.page.goto(this.currentCourseId || this.lastUrl).catch(() => {});
      }
    }
  }

  async runActivityCycle() {
    try {
      // V4: Immediate Hard-Reset on Error state
      if (await this.isErrorState()) {
         logger.warn('Detected Chrome Error Page or Page Crash. Triggering Hard Recovery...');
         await this.refreshSession();
         return;
      }

      await this.page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
      
      const url = this.page.url();
      const isActivity = url.includes('/mod/') || url.includes('view.php?id=') === false; 
      const pageText = await this.page.innerText('body').catch(() => '');

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

      // 4.5. Discussion Forum Handling
      if (url.includes('/mod/forum/') || pageText.includes('Add a new discussion topic')) {
        await this.handleDiscussionForum();
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
        await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
      } else {
        // Fallback for Moodle: Find the text-based link with bold characters which is usually the only visible navigation link on the right.
        const rightNav = await this.page.locator('.activity-navigation a.pull-right, .nav-links a:has(strong, b)').first();
        if (await rightNav.isVisible()) {
          logger.info(`Found potential navigation link: "${await rightNav.innerText()}"`);
          await rightNav.scrollIntoViewIfNeeded();
          await this.safeInteract(rightNav, 'click');
          await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
        } else {
          logger.info('Standard navigation not found. Consulting LLM for the "Smart" next step...');
          const map = await this.getInteractiveMap();
          
          // V3: Inject Reflection Memory into decision
          const experiences = this.getExperiences(this.page.url());
          const decision = await llm.makeDecision({
            url: this.page.url(),
            pageTitle: await this.page.title(),
            interactiveElements: map
          }, experiences);
          
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
      // V3: Save the failure to Reflection Memory
      this.saveExperience(this.page.url(), {
          selector: 'Navigation Search',
          action: 'SEARCH_AND_CLICK',
          result: 'Error',
          message: error.message
      });
      throw error;
    }
  }

  async handleQuiz() {
    try {
      logger.info('Starting Assessment attempt/RE-attempt...');
      const attemptBtn = await this.page.locator('button:has-text("Answer the Questions"), button:has-text("Attempt"), button:has-text("Attempt Quiz"), button:has-text("Continue your attempt"), button:has-text("Re-attempt quiz")').first();
      if (await attemptBtn.isVisible()) {
        await this.safeInteract(attemptBtn, 'click');
        await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
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
          await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
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
  async handleDiscussionForum() {
    logger.info('Handling Discussion Forum Activity...');
    try {
      const addDiscussion = this.page.locator('button:has-text("Add a new discussion topic"), a:has-text("Add a new discussion topic")').first();
      const replyLink = this.page.locator('a:has-text("Reply")').first();

      if (await addDiscussion.isVisible().catch(() => false)) {
          await this.safeInteract(addDiscussion, 'click');
          await this.page.fill('input[name="subject"]', 'Module Review').catch(() => {});
          await this.page.fill('textarea[name="message"]', 'Okay').catch(() => {});
          const postBtn = this.page.locator('button:has-text("Post to forum")').first();
          await this.safeInteract(postBtn, 'click');
          logger.info('New forum post "Okay" submitted.');
      } else if (await replyLink.isVisible().catch(() => false)) {
          await this.safeInteract(replyLink, 'click');
          await this.page.fill('textarea[name="message"]', 'Okay').catch(() => {});
          const postBtn = this.page.locator('button:has-text("Post to forum")').first();
          await this.safeInteract(postBtn, 'click');
          logger.info('Forum reply "Okay" submitted.');
      }
    } catch (e) {
      logger.warn(`Failed to handle Discussion Forum: ${e.message}`);
    }
  }

  async handleEvaluation() {
    logger.info('Handling End of Course Evaluation...');
    // Generic logic to click first option on every radio group (usually 'Very Satisfied')
    const radioGroups = await this.page.$$('.form-group');
    for (const group of radioGroups) {
      const radio = await group.$('input[type="radio"]');
      if (radio) {
        const radioLoc = this.page.locator('input[type="radio"]').filter({ has: this.page.locator(radio) }).first();
        await this.safeInteract(radioLoc, 'click');
      }
    }
    const submitLoc = await this.page.locator('button:has-text("Submit")').first();
    if (await submitLoc.isVisible().catch(() => false)) {
      await this.safeInteract(submitLoc, 'click');
    }
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
            const oldUrl = this.page.url();
            logger.info(`Executing LLM Click on: "${element.text}" (Index ${index})`);
            const preciseLocator = this.page.locator(`${element.tag.toLowerCase()}:has-text("${element.text}")`).first();
            await this.safeInteract(preciseLocator, 'click');
            await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
            
            // Check if we actually moved
            if (this.page.url() === oldUrl) {
                logger.warn(`Click on Index ${index} was inert. Saving to memory.`);
                this.saveExperience(oldUrl, {
                    index,
                    text: element.text,
                    result: 'Inert',
                    lesson: 'This button does not trigger navigation. Use an alternative.'
                });
            }
          }
        }
      } else if (decision.includes('SCROLL_DOWN')) {
        await this.smartScroll();
      } else if (decision.includes('MARK_DONE')) {
        const markDone = await this.page.locator('button:has-text("Mark Done"), .btn-mark-done').first();
        if (await markDone.isVisible()) {
          await markDone.scrollIntoViewIfNeeded();
        await this.safeInteract(markDone, 'click');
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

  async mapCurriculum() {
    logger.info('Building Knowledge Graph of the entire course...');
    try {
      const activities = await this.page.locator('.course-content .activity a').all();
      this.curriculumMap = [];
      for (const link of activities) {
        const title = await link.innerText().catch(() => 'Activity');
        const href = await link.getAttribute('href').catch(() => null);
        if (href) {
          this.curriculumMap.push({ title, url: href });
        }
      }
      logger.info(`Graph complete: Found ${this.curriculumMap.length} total activities.`);
    } catch (e) {
      logger.warn(`Failed to build Curriculum Graph: ${e.message}`);
    }
  }

  async humanWait(type = 'default') {
    const jitter = Math.random() * 5000 + 3000; // 3-8s random wait
    const baseWait = type === 'video' ? 15000 : (type === 'pdf' ? 10000 : 5000);
    const total = baseWait + jitter;
    logger.info(`Simulating human ${type} consumption... waiting ${Math.round(total/1000)}s`);
    await this.page.waitForTimeout(total);
  }

  async refreshSession() {
      logger.info('Time for a technical deep-clean. Refreshing browser context...');
      this.lastRefreshTime = Date.now();
      await this.browser.close();
      await this.start();
      await this.login();
      if (this.currentCourseId) await this.page.goto(this.currentCourseId);
  }

  getExperiences(url) {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
        return data[url] || [];
      }
    } catch (e) {
      logger.warn(`Failed to read reflection memory: ${e.message}`);
    }
    return [];
  }

  saveExperience(url, experience) {
    try {
      let data = {};
      if (fs.existsSync(MEMORY_FILE)) {
        data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
      }
      if (!data[url]) data[url] = [];
      data[url].push({ ...experience, timestamp: new Date().toISOString() });
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
      logger.info(`Reflection Memory updated for URL: ${url}`);
    } catch (e) {
      logger.warn(`Failed to save reflection memory: ${e.message}`);
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
