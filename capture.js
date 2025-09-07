/**
 * Swoogo Evidence Capture – Full Suite
 * -------------------------------------------------------------
 * Captures per registrant (saved into a folder named by Registrant ID):
 *  01) Attendance Status / Proof
 *  02) Contact Details
 *  03) Ticket & Email Delivery (best-effort)
 *  04) QR Code Ticket Email (best-effort)
 *  05) Confirmation (email body only)
 *  06) Invoice (full page)
 *
 * Updates:
 *  - Per-registrant directories by numeric `id`
 *  - Actions ▸ Confirmation / Invoice: extract href and navigate directly
 *  - Hide left navigation/sidebar before screenshots
 *
 * Usage
 *  1) npm init -y
 *     npm i -D playwright csv-parse
 *     npx playwright install chromium
 *
 *  2) Save a logged-in session:
 *     node swoogo_capture_registrant_assets.js --save-session --auth auth.json
 *
 *  3) CSV may have `registrant_url`, or (`id` + `eventId`) (or pass --eventId)
 *
 *  4) Run:
 *     node swoogo_capture_registrant_assets.js --in swoogoReg.csv --auth auth.json --out out --pdf --eventId 255274
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe  = (s) => (s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { in: null, auth: null, outDir: 'out', delay: 300, viewport: { width: 1600, height: 1200 }, saveSession: false, pdf: false, eventId: '' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--in') out.in = args[++i];
    else if (a === '--auth') out.auth = args[++i];
    else if (a === '--out') out.outDir = args[++i];
    else if (a === '--delay') out.delay = Number(args[++i] || out.delay);
    else if (a === '--viewport') {
      const [w, h] = (args[++i] || '').split('x').map(Number);
      if (w && h) out.viewport = { width: w, height: h };
    } else if (a === '--save-session') out.saveSession = true;
    else if (a === '--pdf') out.pdf = true;
    else if (a === '--eventId') out.eventId = String(args[++i] || '').trim();
  }
  return out;
}

// ---- Azure + zipping helpers ----
const { BlobServiceClient } = require('@azure/storage-blob');
const archiver = require('archiver');
const os = require('os');
const fsp = fs.promises;

function buildAzureContainerClient() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
  const container = process.env.AZURE_BLOB_CONTAINER || '';
  const sasUrl = process.env.AZURE_BLOB_SAS_URL || ''; // optional

  if (!container) {
    throw new Error('AZURE_BLOB_CONTAINER is not set');
  }

  if (conn) {
    const service = BlobServiceClient.fromConnectionString(conn);
    return service.getContainerClient(container);
  }
  if (sasUrl) {
    // Expecting full container SAS URL, e.g. https://<acct>.blob.core.windows.net/<container>?<sas>
    return new BlobServiceClient(sasUrl).getContainerClient('');
  }
  throw new Error('Provide either AZURE_STORAGE_CONNECTION_STRING or AZURE_BLOB_SAS_URL');
}

// zip a folder to a .zip (returns the zip path)
async function zipDirectory(dirPath, zipPath) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(zipPath));
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(dirPath, false);
    archive.finalize();
  });
}

// upload a local file to Azure Blob Storage
async function uploadZip(containerClient, localZipPath, blobName) {
  const blockBlob = containerClient.getBlockBlobClient(blobName);
  const stream = fs.createReadStream(localZipPath);
  const stat = fs.statSync(localZipPath);
  await blockBlob.uploadStream(stream, 4 * 1024 * 1024, 5, {
    blobHTTPHeaders: { blobContentType: 'application/zip' },
  });
  return blockBlob.url;
}

// remove a directory recursively
async function rimraf(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
}

// Zip → Upload → Delete local
async function uploadAndCleanupRegistrant(containerClient, regDir, blobName) {
  const tmpZip = path.join(os.tmpdir(), `${blobName}`);
  await zipDirectory(regDir, tmpZip);
  const url = await uploadZip(containerClient, tmpZip, blobName);
  await fsp.unlink(tmpZip).catch(() => {});
  await rimraf(regDir);
  return url;
}

const containerClient = buildAzureContainerClient();

function readCsvRows(fp) {
  const raw = fs.readFileSync(fp, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

async function withBrowser(contextOptions, fn) {
  const browser = await chromium.launch({ headless: false });
  try {
    const ctx = await browser.newContext(contextOptions);
    const page = await ctx.newPage();
    return await fn({ browser, ctx, page });
  } finally {
    await sleep(200);
  }
}

async function saveSession(authPath, viewport) {
  console.log('Opening browser to save session...');
  await withBrowser({ viewport, storageState: undefined }, async ({ browser, ctx, page }) => {
    await page.goto('https://www.swoogo.com/loggedin', { waitUntil: 'domcontentloaded' });
    console.log('\nA Chromium window is open. Please log in to Swoogo, then close the window.');
    while (browser.isConnected()) { await sleep(500); try { if ((browser.contexts?.() || []).length === 0) break; } catch {} }
    const state = await ctx.storageState();
    fs.writeFileSync(authPath, JSON.stringify(state, null, 2));
    console.log(`Saved session to ${authPath}`);
  });
}

// ---------- UI helpers ----------
async function hideLeftPanel(page) {
  await page.addStyleTag({
    content: `
      aside, nav[role="navigation"], [aria-label*="Navigation" i],
      [data-testid*="sidebar" i], [class*="sidebar" i], [class*="Sidebar"],
      .left-panel, .leftpanel, .nav-left, .swoogo-left, .app-sidebar {
        display: none !important;
        visibility: hidden !important;
        width: 0 !important; min-width: 0 !important;
      }
      body { overflow: initial !important; }
      .main, [role="main"], [data-testid*="content" i] { margin-left: 0 !important; }
    `,
  });
}

async function expandScrollableContainers(page) {
  await page.evaluate(() => {
    const isScrollable = (el) => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    };
    document.documentElement.style.overflow = 'visible';
    document.body.style.overflow = 'visible';
    for (const el of Array.from(document.querySelectorAll('*')).filter(isScrollable)) {
      el.setAttribute('__pre_expand__', JSON.stringify({
        h: el.style.height, mh: el.style.maxHeight, oy: el.style.overflowY, o: el.style.overflow
      }));
      el.style.height = el.scrollHeight + 'px';
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
      el.style.overflowY = 'visible';
    }
  });
}
async function restoreScrollableContainers(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[__pre_expand__]')) {
      const prev = JSON.parse(el.getAttribute('__pre_expand__') || '{}');
      el.style.height = prev.h || '';
      el.style.maxHeight = prev.mh || '';
      el.style.overflowY = prev.oy || '';
      el.style.overflow = prev.o || '';
      el.removeAttribute('__pre_expand__');
    }
  });
}

async function captureFullPage(page, fileBase, { pdf = false } = {}) {
  await page.waitForLoadState('domcontentloaded');
  await sleep(250);
  await hideLeftPanel(page);
  await expandScrollableContainers(page);
  await page.screenshot({ path: `${fileBase}.png`, fullPage: true });
  await restoreScrollableContainers(page);
  if (pdf) { try { await page.pdf({ path: `${fileBase}.pdf`, printBackground: true }); } catch {} }
  console.log('  ✔', path.basename(fileBase) + '.png');
}

async function captureConfirmationEmail(page, fileBaseDir, baseName) {
  await page.waitForLoadState('domcontentloaded');
  await sleep(350);

  const iframeLoc = page.locator('iframe');
  const emailCandidates = page.locator('[data-testid*="email" i], .email-body, .emailBody, .email, [class*="email" i], [id*="email" i]');
  let saved = false;

  if (await iframeLoc.count().catch(() => 0)) {
    const p = path.join(fileBaseDir, `${baseName}__05_Confirmation_email.png`);
    const bodyLoc = page.frameLocator('iframe').first().locator('body');
    try { await bodyLoc.screenshot({ path: p }); console.log('  ✔ 05_Confirmation_email.png'); saved = true; } catch {}
  }
  if (!saved && await emailCandidates.count().catch(() => 0)) {
    const p = path.join(fileBaseDir, `${baseName}__05_Confirmation_email.png`);
    await emailCandidates.first().screenshot({ path: p });
    console.log('  ✔ 05_Confirmation_email.png'); saved = true;
  }
  if (!saved) {
    const p = path.join(fileBaseDir, `${baseName}__05_Confirmation_full.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.warn('  ⚠ Could not isolate email body; saved full page instead');
  }
}

async function openActionsMenu(page) {
  const actionsBtn = page.getByRole('button', { name: /actions/i });
  await actionsBtn.waitFor({ state: 'visible' });
  await actionsBtn.click({ delay: 30 });
}

// Finds an anchor whose href contains any of the given substrings.
// Returns an ABSOLUTE url (resolved against the current page) or null.
async function findActionHrefByUrlContains(
    page,
    needles,                     // e.g., ['confirmation'] or ['invoice']
    { openActions = true, timeout = 5000 } = {}
  ) {
    const wanted = (Array.isArray(needles) ? needles : [needles]).map(s => String(s).toLowerCase());
  
    // Ensure the Actions dropdown is in the DOM (if present)
    if (openActions) {
      const actionsBtn = page.getByRole('button', { name: /actions/i });
      if (await actionsBtn.isVisible().catch(() => false)) {
        await actionsBtn.click({ delay: 20 }).catch(() => {});
        await page.waitForTimeout(150);
      }
    }
  
    // Fast path: direct CSS substring search
    const quickSel = wanted.map(n => `a[href*="${n}"]`).join(',');
    const quick = page.locator(quickSel).first();
    if (await quick.isVisible().catch(() => false)) {
      const href = await quick.getAttribute('href').catch(() => null);
      if (href) { try { return new URL(href, page.url()).toString(); } catch { return href; } }
    }
  
    // Fallback: scan all anchors and resolve to absolute
    const href = await page.evaluate((needles) => {
      const ns = needles.map(s => String(s).toLowerCase());
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      for (const a of anchors) {
        const h = a.getAttribute('href') || '';
        if (ns.some(n => h.toLowerCase().includes(n))) {
          const tmp = document.createElement('a');
          tmp.href = h;               // resolves relative to document.baseURI
          return tmp.href;            // absolute
        }
      }
      return null;
    }, wanted);
  
    return href;
  }
  
async function extractRegistrantName(page) {
  const candidates = ['h1','header h1','[data-testid*="registrant" i]','.registrant-name','[class*="Registrant" i]'];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      const text = (await loc.textContent().catch(() => '')) || '';
      const t = text.replace(/\s+/g, ' ').trim();
      if (t) return safe(t);
    }
  }
  return 'registrant';
}

// Find a direct link (or form action) to the "Send Email" preview page
async function getSendEmailHref(page, opts) {
    const registrantUrl = (opts && opts.registrantUrl) || page.url();
  
    // 1) Try visible anchors
    const a = page.locator('a[href*="/loggedin/registrant/send-email"]').first();
    if (await a.count().catch(() => 0)) {
      const href = await a.getAttribute('href');
      if (href) return new URL(href, page.url()).toString();
    }
  
    // 2) Try a form action
    const f = page.locator('form[action*="/loggedin/registrant/send-email"]').first();
    if (await f.count().catch(() => 0)) {
      const action = await f.getAttribute('action');
      if (action) return new URL(action, page.url()).toString();
    }
  
    // 3) Fallback: construct from the current registrant URL (uses default type=4840855)
    const idMatch = /[?&]id=(\d+)/.exec(registrantUrl);
    const eventMatch = /[?&]eventId=(\d+)/.exec(registrantUrl);
    const id = idMatch ? idMatch[1] : '';
    const eventId = eventMatch ? eventMatch[1] : '';
    if (id && eventId) {
      return 'https://www.swoogo.com/loggedin/registrant/send-email'
        + '?eventId=' + encodeURIComponent(eventId)
        + '&id=' + encodeURIComponent(id)
        + '&RegistrantEmailForm%5Btype%5D=4840855';
    }
    return null;
  }
  
  // Replace your current captureIframeBySrc with this version.
// It reliably gets the iframe's contentFrame(), waits for it to fully load,
// expands the document to its full height, then screenshots just the iframe HTML.

async function captureIframeBySrc(page, srcKeyword, outputPath) {
//async function captureEmailIframeFromSendEmail(page, outputPath) {
    // Wait until the preview iframe is attached
    const iframeEl = await page.waitForSelector('iframe[src*="/frontend/preview/email"]', { timeout: 15000 });    
    // Force the iframe element to expand taller (e.g. 1000px or auto)
    await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="/frontend/preview/email"]');
        if (iframe) {
            iframe.style.height = "1000px";   // set CSS height
            iframe.removeAttribute("height"); // remove restrictive attribute if present
            }
    });
  
    const frame = await iframeEl.contentFrame();
    if (!frame) {
        console.warn('⚠ Could not resolve contentFrame; fallback to full page screenshot');
        await page.screenshot({ path: outputPath.replace(/.png$/, '__full.png'), fullPage: true });
        return;
    }
    
    // Ensure the iframe document has loaded
    await frame.waitForLoadState('domcontentloaded');
    
    // Expand the iframe document to its full scroll height
    await frame.evaluate(() => {
        const html = document.documentElement;
        const body = document.body;
        html.style.overflow = 'visible';
        body.style.overflow = 'visible';
    
        // Compute the tallest measurement
        const totalH = Math.max(
        html.scrollHeight, body.scrollHeight,
        html.offsetHeight, body.offsetHeight
        );
        html.style.height = totalH + 'px';
        body.style.height = totalH + 'px';
    });
    
    // Wait a little for lazy images to load
    await frame.waitForTimeout(400);
    
    // Screenshot just the iframe’s html root
    await frame.locator('html').screenshot({ path: outputPath });
    
    console.log('✔ Full email captured →', outputPath);
    }
        
  // Capture ONLY the email content from the preview iframe on the Send Email page
  async function captureEmailIframeFromSendEmail(page, outputPath) {
    // Wait for the preview iframe (src starts with /frontend/preview/email)
    await page.waitForSelector('iframe[src^="/frontend/preview/email"], iframe[src*="/frontend/preview/email"]', { timeout: 15000 });
  
    // Get a frame handle by URL
    const frame = page.frames().find(fr => {
      try { return /\/frontend\/preview\/email/.test(fr.url()); } catch { return false; }
    }) || page.frame({ url: (u) => u.includes('/frontend/preview/email') });
  
    if (!frame) {
      // Fallback: save full page if we couldn't find the preview frame
      await page.screenshot({ path: outputPath.replace(/\.png$/, '__full.png'), fullPage: true });
      return false;
    }
  
    // Expand the frame's document so the whole email is visible (no cropping)
    try {
      await frame.evaluate(() => {
        const html = document.documentElement; const body = document.body;
        html.style.overflow = 'visible'; body.style.overflow = 'visible';
        const h = Math.max(html.scrollHeight, body.scrollHeight, html.offsetHeight, body.offsetHeight);
        html.style.height = h + 'px'; body.style.height = 'auto';
      });
    } catch {}
  
    // Prefer a clear email container if present; otherwise capture the whole frame body
    const emailBodyLoc = frame.locator('[data-testid*="email" i], .email-body, .emailBody, .email, body').first();
    await emailBodyLoc.screenshot({ path: outputPath });
    return true;
  }
  
  async function waitForSpinnerGone(page, { timeout = 30000 } = {}) {
    // Wait until #spinner-overlay is hidden (display: none or detached)
    await page.waitForFunction(() => {
      const el = document.querySelector('#spinner-overlay');
      if (!el) return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    }, { timeout });
  
    // Give network a chance to settle
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(300);
  }
  
  
async function processRegistrant(page, registrantUrl, baseOutDir, delay, pdf, containerClient) {
  console.log(`\n▶ ${registrantUrl}`);
  await page.goto(registrantUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(delay);

  // Folder per registrant by numeric id
  const idMatch = /[?&]id=(\d+)/.exec(registrantUrl);
  const regId = idMatch ? idMatch[1] : 'unknown';
  const regDir = path.join(baseOutDir, regId);
  fs.mkdirSync(regDir, { recursive: true });

  const name = await extractRegistrantName(page);
  const baseName = safe(`${regId}`);

  // 01) Attendance Status / Proof
  await captureFullPage(page, path.join(regDir, `${baseName}__01_Attendance_Status_Proof`), { pdf });

  // 02) Contact Details
  await captureFullPage(page, path.join(regDir, `${baseName}__02_Contact_Details`), { pdf });

  // Pull direct hrefs from Actions menu
  const confirmationHref = await findActionHrefByUrlContains(page, ['confirmation']);
  const invoiceHref = await findActionHrefByUrlContains(page, ['invoice']);

  // 05) Confirmation (email BODY)
  if (confirmationHref) {
    await page.goto(confirmationHref, { waitUntil: 'domcontentloaded' });
    await waitForSpinnerGone(page).catch(() => {});
    await captureConfirmationEmail(page, regDir, baseName);
  } else {
    console.warn('  ⚠ Could not resolve Confirmation URL from Actions; attempting click fallback.');
    try {
      await openActionsMenu(page);
      const [popup] = await Promise.all([
        page.waitForEvent('popup').catch(() => null),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
        page.getByRole('menuitem', { name: /confirmation/i }).first().click({ delay: 30 }),
      ]);
      const target = popup || page;
      await captureConfirmationEmail(target, regDir, baseName);
      if (popup) await popup.close().catch(() => {});
      await page.bringToFront();
    } catch {}
  }

  // 06) Invoice (full page)
  if (invoiceHref) {
    await page.goto(invoiceHref, { waitUntil: 'domcontentloaded' });
    await waitForSpinnerGone(page).catch(() => {});
    await captureFullPage(page, path.join(regDir, `${baseName}__06_Invoice`), { pdf });
  } else {
    console.warn('  ⚠ Could not resolve Invoice URL from Actions; attempting click fallback.');
    try {
      await openActionsMenu(page);
      const [popup] = await Promise.all([
        page.waitForEvent('popup').catch(() => null),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
        page.getByRole('menuitem', { name: /invoice/i }).first().click({ delay: 30 }),
      ]);
      const target = popup || page;
      await captureFullPage(target, path.join(regDir, `${baseName}__06_Invoice`), { pdf });
      if (popup) await popup.close().catch(() => {});
      await page.bringToFront();
    } catch {}
  }

  // 03) Ticket & Email Delivery (best-effort)
// 03) Ticket Email Preview (Send Email page) – capture ONLY the email iframe content
try {
  const sendEmailHref = await getSendEmailHref(page, { registrantUrl });
  if (sendEmailHref) {
    await page.goto(sendEmailHref, { waitUntil: 'domcontentloaded' });
    await sleep(Math.max(200, delay));
    const emailShot = path.join(regDir, baseName + '__03_Ticket_Email_Preview.png');
    //const ok = await captureEmailIframeFromSendEmail(page, emailShot);
    const ok = await captureIframeBySrc(page, '/frontend/preview/email', emailShot);
    if (!ok) console.warn('  ⚠ Email iframe not found; saved full page instead');
  }
} catch (e) {
  console.warn('  ⚠ Could not capture Ticket Email Preview:', e && e.message ? e.message : e);
}


  // 04) QR Code Ticket Email (best-effort)
  try {
    const qrLink = page.locator('a[href*="/loggedin/registrant/send-email"], form[action*="/loggedin/registrant/send-email"]').first();
    if (await qrLink.isVisible().catch(() => false)) {
      const href = await qrLink.getAttribute('href');
      if (href) {
        await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded' });
        await captureFullPage(page, path.join(regDir, `${baseName}__04_QR_Code_Ticket_Email`), { pdf });
      } else {
        await captureFullPage(page, path.join(regDir, `${baseName}__04_QR_Code_Ticket_Email`), { pdf });
      }
    }
  } catch {}

  // ---- Zip, upload to Azure, then delete local directory ----
  try {
    // one zip per registrant id; you can switch to baseName if you prefer
    const blobName = `${regId}.zip`;
    const uploadedUrl = await uploadAndCleanupRegistrant(containerClient, regDir, blobName);
    console.log('  ☁ Uploaded to Azure:', uploadedUrl);
    console.log('  🗑️  Deleted local folder:', regDir);
  } catch (e) {
    console.error('  ⚠ Azure upload failed. Keeping local folder.', e?.message || e);
  }
  
}

(async () => {
  const args = parseArgs();
  if (args.saveSession) { const authPath = path.resolve(args.auth || 'auth.json'); await saveSession(authPath, args.viewport); process.exit(0); }
  if (!args.in) { console.error('Missing --in <registrants.csv>'); process.exit(1); }

  const outRoot = path.resolve(args.outDir);
  fs.mkdirSync(outRoot, { recursive: true });

  const rows = readCsvRows(args.in);
  const urls = [];

  for (const r of rows) {
    let url = (r.registrant_url || r.RegistrantURL || '').toString().trim();
    const id = (r.id || r.ID || r['Registrant ID'] || r.registrantId || r.registrant_id || '').toString().trim();
    const csvEvent = (r.eventId || r['Event ID'] || r.event_id || '').toString().trim();
    const eventId = (args.eventId || '').toString().trim() || csvEvent;
    if (!url && id && eventId) url = `https://www.swoogo.com/loggedin/registrant/view?eventId=${encodeURIComponent(eventId)}&id=${encodeURIComponent(id)}`;
    if (url) urls.push(url);
  }
  if (urls.length === 0) { console.error('No usable rows found.'); process.exit(1); }

  const contextOptions = { viewport: args.viewport };
  if (args.auth && fs.existsSync(args.auth)) contextOptions.storageState = args.auth;

  await withBrowser(contextOptions, async ({ page }) => {
    for (const u of urls) {
      try {
        await processRegistrant(page, u, outRoot, args.delay, args.pdf, containerClient);
      } catch (err) {
        console.error('  ✖ Error for', u, '\n   ', err?.message || err);
      }
    }
  });

  console.log('\nDone. Files saved in:', path.relative(process.cwd(), outRoot));
})();
