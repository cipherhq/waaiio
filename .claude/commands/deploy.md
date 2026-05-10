# Deploy and Verify

Push code, monitor Vercel deployment, and verify the live site.

## Usage
`/deploy [--message "commit message"]`

## Instructions

1. **Check for uncommitted changes:**
   ```bash
   git status
   git diff --name-only
   ```

2. **If there are changes, commit them:**
   - Stage relevant files (not .env or node_modules)
   - Create a descriptive commit message
   - Push to main

3. **Verify the push succeeded:**
   ```bash
   git log --oneline -1
   ```

4. **Check Vercel deployment status** (if `vercel` CLI is available):
   ```bash
   npx vercel ls --limit 1
   ```
   Otherwise, inform the user that Vercel will auto-deploy from the push and it usually takes 2-3 minutes.

5. **Verify the build would succeed locally:**
   ```bash
   npx next build 2>&1 | tail -5
   ```

6. **Report:**
   - What was pushed (commit hash, files changed)
   - Build status (pass/fail)
   - Remind user to hard-refresh after Vercel deploys (Ctrl+Shift+R)

## Notes
- Always commit with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Never force push to main
- If build fails, fix the error first before pushing
