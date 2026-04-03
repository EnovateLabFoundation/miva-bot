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
        logger.info(`SafeInteract: Performing click on element`);
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await locator.click({ timeout: 5000 }).catch(async () => {
             // Fallback to evaluation click for inert/hidden elements
             await locator.evaluate(el => el.click());
        });
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

  async isErrorState() {
    try {
      if (!this.page || this.page.isClosed()) return true;
      const url = this.page.url();
      const title = await this.page.title().catch(() => '');
      return (url.includes('chrome-error://') || url === 'about:blank' || title.includes('Loading...'));
    } catch (e) {
      return true;
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
        logger.warn(`Action failed (Attempt ${i + 1}/${retries}): ${error.message}. Retrying...`);
        await this.page.waitForTimeout(delay);
      }
    }
  }

  async searchForNavigation() {
    // Zone 0: Footer Navigation (Highest reliability)
    const footerNext = this.page.locator('#next-activity-link, .next-activity-link, a:has-text("Next Activity"), .mod_quiz-next-nav').first();
    const navbarNext = this.page.locator('#courseNext a, .activity-navigation a:has-text("Next"), .activity-navigation a:has-text("Next section")').first();
    const containerNext = this.page.locator('.course-content a:has(strong, b), .course-content a:has-text("Next Page"), .course-content button:has-text("Continue")').first();
    const zones = [footerNext, navbarNext, containerNext];
    
    for (const loc of zones) {
        if (await loc.isVisible().catch(() => false)) return loc;
    }
    await this.smartScroll();
    for (const loc of zones) {
        if (await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
  }

  async jumpToNextUncompleted() {
    logger.info('Master Flow: Executing Forced Curriculum Jump...');
    const drawer = this.page.locator('.drawertoggle, [aria-label="Course index"], #accordionEx1').first();
    if (await this.page.locator('#accordionEx1, .courseindex-content').isHidden()) {
        await this.safeInteract(drawer, 'click');
        await this.page.waitForTimeout(2000);
    }
    
    const items = await this.page.locator('.activity-item, .courseindex-item').all();
    for (const item of items) {
        const isDone = await item.locator('.complete_icon, .fa-check, .completion-info .badge-success, [aria-label="Done"]').isVisible().catch(() => false);
        const isTodo = await item.locator('.completion_incomplete, [aria-label="To do"], .fa-circle, .fa-regular.fa-circle').isVisible().catch(() => false);
        const isActive = await item.evaluate(el => el.closest('.card, .courseindex-item')?.classList.contains('active')).catch(() => false);
        
        if (isTodo && !isActive) {
            const link = item.locator('a').first();
            if (await link.isVisible()) {
                const label = await link.innerText().catch(() => 'Next Activity');
                logger.info(`Jump Engine: Targeting "${label.trim()}" (Status: TO DO).`);
                await this.safeInteract(link, 'click');
                await this.page.waitForLoadState('load').catch(() => {});
                this.stuckCounter = 0;
                return true;
            }
        }
    }
    return false;
  }

  async start() {
    if (this.isRunning) throw new Error('Automation already in progress.');
    this.isRunning = true;
    try {
      this.browser = await chromium.launch({ headless: this.isHeadless });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
      logger.info('Browser initialized');
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  async login() {
    const email = process.env.MIVA_EMAIL;
    const password = process.env.MIVA_PASSWORD;
    logger.info(`Scholar V6.5 LOGIN START: ${email}`);
    try {
      await this.withRetry(async () => {
        await this.page.goto('https://sis.miva.university/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        const emailInput = await this.page.waitForSelector('input[name="email"]', { state: 'visible', timeout: 30000 });
        await emailInput.fill(email);
        await this.page.fill('input[name="password"]', password);
        await this.safeInteract(this.page.locator('button:has-text("Login")'), 'click');
        await this.page.waitForURL(/.*dashboard.*/, { timeout: 45000 }).catch(() => {});
      });
      logger.info('Login sequence finalized.');
    } catch (error) {
      await this.analyzeFailure('Login failure', error);
      throw error;
    }
  }

  async goToLMS() {
    logger.info('Navigating to LMS courses catalog...');
    await this.page.goto('https://sis.miva.university/courses');
    const goToClassBtn = this.page.locator(':text("Go to Class")').first();
    await goToClassBtn.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
    const [newPage] = await Promise.all([
      this.context.waitForEvent('page'),
      this.safeInteract(goToClassBtn, 'click'),
    ]);
    this.page = newPage;
    await this.page.waitForLoadState();
  }

  async handleCourse(courseName) {
    if (courseName.startsWith('http')) await this.page.goto(courseName);
    else {
      const courseCard = await this.page.locator(`div:has-text("${courseName}")`).first();
      await this.safeInteract(courseCard, 'scroll');
      await this.safeInteract(courseCard.locator('a:has-text("View Course")').first(), 'click');
    }
    await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await this.mapCurriculum();
    this.currentCourseId = this.page.url();

    let finished = false;
    while (!finished) {
      try {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
        const progress = await this.getProgress();
        if (progress >= 100) {
          if (this.alertCallback) this.alertCallback(`Success! Course ${courseName} complete.`);
          finished = true;
          break;
        }
        await this.ensureInActivity();
        await this.runActivityCycle();
        await this.checkForStuck();
        if (Date.now() - this.lastRefreshTime > 45 * 60 * 1000) await this.refreshSession();
        await this.page.waitForTimeout(1000); 
      } catch (error) {
        if (error.message.includes('context was destroyed')) continue;
        throw error;
      }
    }
  }

  async mapCurriculum() {
    logger.info('Scholar V6.1 Curriculum Mapping sequence...');
    await this.page.waitForTimeout(5000); 
    let sidebarLinks = await this.page.locator('.courseindex-link, .aalink, .activityname').all();
    if (sidebarLinks.length === 0) {
      logger.info('Sidebar hydration gap detected. Handshaking drawer toggle...');
      const drawerToggle = this.page.locator('.drawertoggle, [data-region="drawer-toggle"]').first();
      if (await drawerToggle.isVisible()) {
          await this.safeInteract(drawerToggle, 'click');
          await this.page.waitForTimeout(3000);
          sidebarLinks = await this.page.locator('.courseindex-link, .aalink, .activityname').all();
      }
    }
    this.curriculumMap = [];
    for (const link of sidebarLinks) {
      const title = await link.innerText().catch(() => '');
      const url = await link.getAttribute('href').catch(() => '');
      if (title && url) this.curriculumMap.push({ title: title.trim(), url });
    }
    logger.info(`Curriculum Knowledge Graph built: ${this.curriculumMap.length} activities mapped.`);
  }

  async getProgress() {
    try {
      const fmProgressBar = this.page.locator('.fm-navbar .progress-bar, .course-progress-value').first();
      if (await fmProgressBar.isVisible()) {
          const ariaValue = await fmProgressBar.getAttribute('aria-valuenow').catch(() => null);
          if (ariaValue) return parseInt(ariaValue);
      }
      const fmProgressText = this.page.locator('.progress-text, .progress-bar-text').first();
      if (await fmProgressText.isVisible()) {
          const text = await fmProgressText.innerText();
          const match = text.match(/(\d+)%/);
          if (match) return parseInt(match[1]);
      }
    } catch (e) {
      logger.warn(`Progress error: ${e.message}`);
    }
    return 0;
  }

  async hasUncompletedTasksInDrawer() {
    try {
      const drawer = this.page.locator('#accordionEx1, .courseindex-content');
      if (await drawer.isVisible({ timeout: 5000 }).catch(() => false)) {
        const items = await drawer.locator('.activity-item, .courseindex-item').all();
        let uncompletedCount = 0;
        for (const item of items) {
          const isDone = await item.locator('.complete_icon, .fa-check, .completion-info .badge-success').isVisible().catch(() => false);
          if (!isDone) uncompletedCount++;
        }
        return uncompletedCount > 0;
      }
    } catch (e) {}
    return false;
  }

  async ensureInActivity() {
    const url = this.page.url();
    if (url.includes('course/view.php')) {
      const resumeBtn = this.page.locator('button:has-text("Resume"), a:has-text("Resume"), button:has-text("Continue"), a:has-text("Continue")').first();
      if (await resumeBtn.isVisible()) {
          await this.safeInteract(resumeBtn, 'click');
          await this.page.waitForLoadState('load').catch(() => {});
      }
    }
  }

  async checkForStuck() {
    const currentUrl = this.page.url();
    if (currentUrl === this.lastUrl) this.stuckCounter++;
    else this.stuckCounter = 0;
    this.lastUrl = currentUrl;

    if (this.stuckCounter > 5) {
      logger.warn('HARD STUCK state detected. Clearing session.');
      this.stuckCounter = 0;
      await this.refreshSession();
      return;
    }
    if (this.stuckCounter > 3) {
      logger.warn('STUCK state. Re-basing to landing page.');
      this.stuckCounter = 0;
      await this.page.goto(this.currentCourseId || this.lastUrl).catch(() => {});
    }
  }

  async runActivityCycle() {
    try {
      const url = this.page.url();
      const isActivity = url.includes('/mod/') || url.includes('view.php?id=') === false; 
      const pageText = await this.page.innerText('body').catch(() => '');
      const pageTitle = await this.page.title().catch(() => '');
      const mainHeading = await this.page.locator('h1, h2, h3').first().innerText().catch(() => '').then(t => t.trim());

      logger.info(`--- MASTER FLOW V6.5 START: ${url} ---`);

      // STATE 1: Mark Done & Skip Completed (Priority Actions)
      const isDoneStatus = await this.page.locator('[aria-label="Done"], .completion_complete').first().isVisible().catch(() => false);
      if (isDoneStatus) {
          logger.info('Master Flow: Activity already DONE. Advancing to next...');
          const nextBtn = await this.searchForNavigation();
          if (nextBtn) { await this.safeInteract(nextBtn, 'click'); return; }
      }

      const markDoneBtn = await this.page.locator('button[data-region="completion-info"], button[aria-label*="Mark as done"], .btn-mark-done').first();
      if (await markDoneBtn.isVisible().catch(() => false)) {
        const btnText = await markDoneBtn.innerText().catch(() => '');
        if (btnText.toLowerCase().includes('mark as done') || btnText.toLowerCase().includes('to do')) {
          logger.info('Master Flow: Executing "Mark Done" (Priority 1)');
          await this.safeInteract(markDoneBtn, 'click');
          await this.page.waitForTimeout(2000);
        }
      }

      // STATE 2: Alert for Manual Actions
      if (pageText.includes('upload your file') || pageText.includes('download the template') || pageText.includes('Submit a file')) {
        if (this.alertCallback) {
          const detailMsg = `🚨 MANUAL ACTION REQUIRED: "${pageTitle}"\nURL: ${url}\nContext: The LMS requires a manual file upload/download. Please finish this to continue the automation flow.`;
          await this.alertCallback(detailMsg);
        }
      }

      // STATE 3: Skip Logic
      const skipKeywords = ['Live Lesson', 'Office Hours', 'Course Material', 'Introduction Video'];
      if (isActivity && skipKeywords.some(k => pageTitle.includes(k) || mainHeading.includes(k))) {
        logger.info(`Master Flow: Skipping non-graded material: "${pageTitle}"`);
        const nextActivity = await this.page.locator('a#next-activity-link, .next-activity-link, a:has-text("Next Activity")').first();
        if (await nextActivity.isVisible().catch(() => false)) {
          await this.safeInteract(nextActivity, 'click');
          return;
        }
      }

      // STATE 4: Consumption Logic
      const video = this.page.locator('video, .jw-video, .vjs-tech').first();
      const pdf = this.page.locator('iframe[src*="pdf"], embed[type="application/pdf"], .pdf-container').first();
      if (await video.isVisible().catch(() => false)) {
        logger.info('Master Flow: Consuming Video content (Simulating play/wait)...');
        await this.page.evaluate(() => {
          const v = document.querySelector('video') || document.querySelector('.jw-video') || document.querySelector('.vjs-tech');
          if (v && v.duration) {
              v.play().catch(() => {});
              v.currentTime = v.duration - 3.5; // Leave 3.5s to play out
          }
        });
        await this.page.waitForTimeout(5000); // Wait for the remaining 3s to play and register
      } else if (await pdf.isVisible().catch(() => false)) {
        logger.info('Master Flow: Consuming PDF content...');
        await this.smartScroll();
        await this.page.waitForTimeout(2000);
      }

      // STATE 5: Assessment Entry Handlers
      const quizKeywords = ['Attempt', 'Answer the questions', 'Re-attempt', 'Continue your'];
      const quizBtnSelector = quizKeywords.map(k => `button:has-text("${k}"), a:has-text("${k}"), input[value*="${k}"]`).join(', ');
      const quizActionBtn = this.page.locator(quizBtnSelector).first();

      const isSummaryOrReview = url.includes('summary.php') || url.includes('review.php');

      if (!isSummaryOrReview && await quizActionBtn.isVisible().catch(() => false)) {
        logger.info(`Master Flow: Entering Assessment: "${await quizActionBtn.innerText().catch(() => 'Quiz')}"`);
        await this.safeInteract(quizActionBtn, 'click');
        await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
        return; 
      }

      if ((await this.page.locator('.que').count().catch(() => 0)) > 0 || isSummaryOrReview) {
        await this.handleQuiz();
      }

      // STATE 6: Evaluation & Forum
      if (pageText.includes('End of course evaluation') || pageTitle.includes('Evaluation')) await this.handleEvaluation();
      if (url.includes('/mod/forum/') || pageText.includes('Add a new discussion topic')) await this.handleDiscussionForum();

      // STATE 7: Final Navigation
      const nextBtn = await this.searchForNavigation();
      
      // V6.6: Loop Breaking Force (Notice repetitive hits)
      if (this.stuckCounter >= 3) {
          logger.warn(`Master Flow: Loop detected on ${url}. Activating Jump Engine...`);
          const jumped = await this.jumpToNextUncompleted();
          if (jumped) return;
      }

      if (nextBtn) {
        logger.info('Master Flow Outcome: Moving to next activity.');
        await this.safeInteract(nextBtn, 'click');
        await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
      } else {
        logger.info('Standard navigation not found. Consulting LLM for the "Smart" next step...');
        const map = await this.getInteractiveMap();
        const decision = await llm.makeDecision({
          url: this.page.url(),
          pageTitle: await this.page.title(),
          interactiveElements: map
        }, this.getExperiences(this.page.url()));
        if (decision) await this.executeDecision(decision, map);
      }
    } catch (error) {
      if (!error.message.includes('context was destroyed')) throw error;
    }
  }

  async handleQuiz() {
    try {
      logger.info('V6.5 Assessment Logic Active...');
      // Start/Submit Handlers
      const startConfirm = this.page.locator('button:has-text("Start attempt"), input[value="Start attempt"]').first();
      if (await startConfirm.isVisible({ timeout: 3000 }).catch(() => false)) {
          await this.safeInteract(startConfirm, 'click');
          await this.page.waitForLoadState('load').catch(() => {});
      }

      let assessmentFinished = false;
      while (!assessmentFinished) {
        const isSummary = await this.page.locator('body#page-mod-quiz-summary, h2:has-text("Summary of attempt"), .summarytable').first().isVisible();
        const isReview = this.page.url().includes('review.php');

        if (isSummary) {
            logger.info('Summary page detected. Triggering final submission...');
            const finishBtn = this.page.locator('button:has-text("Submit all and finish"), input[value="Submit all and finish"]').first();
            if (await finishBtn.isVisible()) {
                await this.safeInteract(finishBtn, 'click');
                const confirmBtn = this.page.locator('.modal-dialog button:has-text("Submit all and finish"), .confirmation-buttons input[value="Submit all and finish"]').first();
                if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await this.safeInteract(confirmBtn, 'click');
                    await this.page.waitForLoadState('load', { timeout: 45000 }).catch(() => {});
                }
            }
            assessmentFinished = true;
            break;
        }

        if (isReview) { assessmentFinished = true; break; }

        const qLocs = await this.page.locator('.que').all();
        if (qLocs.length === 0) {
            const endLink = this.page.locator('.submitbtns a:has-text("Finish attempt"), .endtestlink, button:has-text("Finish attempt")').first();
            if (await endLink.isVisible()) {
                await this.safeInteract(endLink, 'click');
                continue;
            }
            break;
        }

        for (const [idx, qLoc] of qLocs.entries()) {
            await qLoc.scrollIntoViewIfNeeded({ block: 'center' });
            const qText = await qLoc.locator('.qtext').innerText();
            const options = await qLoc.locator('label').allInnerTexts();
            const answer = await llm.solveQuizQuestion(qText, options);
            logger.info(`Q${idx+1}: ${answer}`);

            const alphabetMatch = answer.match(/^([a-dA-D])\./);
            let optionLocator = null;
            if (alphabetMatch) {
                const charIndex = alphabetMatch[1].toLowerCase().charCodeAt(0) - 97;
                optionLocator = qLoc.locator(`.r${charIndex} input[type="radio"], .r${charIndex} label`).first();
            }
            if (!optionLocator || !(await optionLocator.isVisible().catch(() => false))) {
                 optionLocator = qLoc.locator('label').filter({ hasText: new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
            }
            await this.safeInteract(optionLocator, 'click');
        }

        const nextP = this.page.locator('input[value="Next page"], button:has-text("Next page"), .mod_quiz-next-nav').first();
        if (await nextP.isVisible()) {
            await this.safeInteract(nextP, 'click');
            await this.page.waitForLoadState('load').catch(() => {});
        } else {
            const finishLink = this.page.locator('.submitbtns a:has-text("Finish attempt"), button:has-text("Finish attempt")').first();
            if (await finishLink.isVisible()) {
                await this.safeInteract(finishLink, 'click');
                await this.page.waitForLoadState('load').catch(() => {});
            } else assessmentFinished = true;
        }
      }
    } catch (e) {
      logger.warn(`Assessment error: ${e.message}`);
    }
  }

  async handleEvaluation() {
    logger.info('Handling Course Evaluation...');
    const ansBtn = this.page.locator('a:has-text("Answer the questions")').first();
    if (await ansBtn.isVisible()) {
        await this.safeInteract(ansBtn, 'click');
        await this.page.waitForTimeout(3000);
        const radioOptions = await this.page.locator('input[type="radio"]').all();
        for (const radio of radioOptions) {
            if (await radio.evaluate(el => el.value === '5')) await radio.check().catch(() => {});
        }
        await this.safeInteract(this.page.locator('input[type="submit"], button:has-text("Submit")').first(), 'click');
    }
  }

  async handleDiscussionForum() {
    const addSubject = this.page.locator('input[name="subject"]').first();
    if (await addSubject.isVisible()) {
        await addSubject.fill('Module Completion Support');
        await this.page.fill('textarea[name="message"]', 'Successfully completed the module.');
        await this.safeInteract(this.page.locator('button:has-text("Post to forum")').first(), 'click');
    }
  }

  async executeDecision(decision, map) {
    const match = decision.match(/CLICK_INDEX\((\d+)\)/);
    if (match) {
        const index = parseInt(match[1]);
        const element = map[index];
        if (element) {
            logger.info(`Executing Decision: Click index ${index} (${element.text})`);
            await this.page.mouse.click(element.x + element.width/2, element.y + element.height/2);
            await this.page.waitForLoadState('load').catch(() => {});
        }
    }
  }

  async analyzeFailure(msg, error) {
    logger.error(`${msg}: ${error.message}`);
    await this.saveDebugState(msg.replace(/\s+/g, '_').toUpperCase());
  }

  async saveDebugState(tag) {
    if (!this.page) return;
    const dir = 'screenshots/debug';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    await this.page.screenshot({ path: `${dir}/${tag}_${ts}.png` });
    fs.writeFileSync(`${dir}/${tag}_${ts}.html`, await this.page.content());
  }

  async refreshSession() {
    logger.info('Refreshing session context...');
    try {
      await this.stop();
      await this.start();
      await this.login();
      await this.goToLMS();
      this.lastRefreshTime = Date.now();
    } catch (e) {
      logger.error(`Critical Re-login failed: ${e.message}`);
    }
  }

  getExperiences(url) {
    if (!fs.existsSync(MEMORY_FILE)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        return data.filter(e => e.url === url);
    } catch (e) { return []; }
  }

  saveExperience(url, experience) {
    if (!fs.existsSync(path.dirname(MEMORY_FILE))) fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    let data = [];
    if (fs.existsSync(MEMORY_FILE)) data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    data.push({ url, timestamp: new Date().toISOString(), ...experience });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data.slice(-50), null, 2));
  }

  async stop() {
    this.isRunning = false;
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('Browser stopped');
    }
  }
}

module.exports = new BrowserEngine();
