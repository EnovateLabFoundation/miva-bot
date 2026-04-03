# Level 2 Authorization: Scholar V4 Environmental Resilience

I have received Level 1 approval for the "Hard Recovery" architecture. This is the **Level 2 final authorization** check. Below are the core technical modifications that will enable the bot to survive page crashes and browser error states.

## Proposed Changes

### 1. Chrome Error Detection (Crash Handling)
The bot currently tries to "read" chrome error pages. We will now detect them and force a hard restart.

```javascript
  isErrorState() {
     const url = this.page ? this.page.url() : '';
     const title = this.page ? this.page.title().catch(() => '') : '';
     return (url.includes('chrome-error://') || url === 'about:blank' || title === 'Loading...');
  }
```

### 2. Hard Re-Basing (Stuck Logic)
Instead of just navigating to the `lastUrl` (which might be the cause of the crash), the bot will now perform a **Hard Reset** if it's stuck for more than 5 cycles.

```javascript
    if (this.stuckCounter > 5) {
      logger.warn('Detected HARD STUCK state. Clearing browser context entirely...');
      await this.refreshSession();
      return;
    }
```

### 3. Integrated Resilience (Run Loop)
Adding the Error Detection to the main `runActivityCycle` to catch crashes instantly.

```javascript
  async runActivityCycle() {
    if (this.isErrorState()) {
       logger.warn('Detected Chrome Error Page or Incomplete Load. Triggering Hard Recovery...');
       await this.refreshSession();
       return;
    }
    // ... existing logic
  }
```

---
### Action Required
Please review this "Environmental Armor" set. If you approve, I will apply these resilience triggers and restart the bot for its most stable run yet.
