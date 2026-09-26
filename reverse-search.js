#!/usr/bin/env node
// Watch a directory for new images; for each one, upload it to every enabled
// reverse-image engine in its own Chromium window, tiled across the screen.
//
//   node reverse-search.js [dir] [--existing] [--gap 0]
//                          [--no-tineye] [--no-google] [--no-yandex] [--no-baidu]
//                          [--bing] [--only tineye,google]
//
// Every engine except Bing is on by default; Bing is opt-in via `--bing` or
// `--only`. Each new image closes the previous windows and opens a fresh set.

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import chokidar from 'chokidar';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic']);
const PROFILE_DIR = path.join(import.meta.dirname, '.browser-profiles');
const T = 10_000; // one timeout for every wait in here

// `--gap` and `--only` take a value, so that value must not be mistaken for
// the watch directory.
const VALUED = new Set(['--gap', '--only']);
const args = process.argv.slice(2);
const flags = new Set();
const values = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eq = a.indexOf('=');
  if (a.startsWith('--') && eq !== -1 && VALUED.has(a.slice(0, eq))) values[a.slice(2, eq)] = a.slice(eq + 1);
  else if (VALUED.has(a)) values[a.slice(2)] = args[++i];
  else if (a.startsWith('--')) flags.add(a);
  else positional.push(a);
}
const watchDir = path.resolve(positional[0] ?? './001');
const gap = Number(values.gap ?? 0);

const ENGINES = {
  tineye: { label: 'TinEye', run: searchTinEye },
  google: { label: 'Google Lens', run: searchGoogle },
  yandex: { label: 'Yandex', run: searchYandex },
  baidu: { label: 'Baidu', run: searchBaidu },
  // Bing only names the subject rather than listing matches (see searchBing),
  // so it is off unless asked for.
  bing: { label: 'Bing Visual Search', run: searchBing, optIn: true },
};

const only = values.only
  ?.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
for (const name of only ?? []) {
  if (!ENGINES[name]) throw new Error(`--only: unknown engine "${name}" (have ${Object.keys(ENGINES).join(', ')})`);
}
const enabled = Object.keys(ENGINES).filter((n) =>
  only ? only.includes(n) : ENGINES[n].optIn ? flags.has(`--${n}`) : !flags.has(`--no-${n}`),
);
if (!enabled.length) throw new Error('every engine is disabled — nothing to do');

/**
 * Usable screen area (excludes menu bar / Dock). Finder's desktop bounds cover
 * the whole display, so windows tiled to them get shoved up off the Dock and
 * overlap; NSScreen's visibleFrame is the real thing. It is measured from the
 * bottom-left, so flip it against the primary screen's height.
 */
function screenBounds() {
  try {
    const out = execFileSync('osascript', [
      '-l', 'JavaScript',
      '-e', 'ObjC.import("AppKit")',
      '-e', `const v = $.NSScreen.mainScreen.visibleFrame, H = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
             [v.origin.x, H - v.origin.y - v.size.height, v.size.width, v.size.height].join(",")`,
    ], { encoding: 'utf8' });
    const [x, y, width, height] = out.trim().split(',').map(Number);
    return { x, y, width, height };
  } catch {
    return { x: 0, y: 0, width: 2560, height: 1400 };
  }
}

const screen = screenBounds();

/**
 * Tile `n` windows: a single row for one or two engines, a grid two columns
 * wide up to four (one per quadrant), three columns beyond that.
 */
function tile(n) {
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const width = Math.floor((screen.width - gap * (cols - 1)) / cols);
  const height = Math.floor((screen.height - gap * (rows - 1)) / rows);
  return Array.from({ length: n }, (_, i) => ({
    x: screen.x + (i % cols) * (width + gap),
    y: screen.y + Math.floor(i / cols) * (height + gap),
    width,
    height,
  }));
}

const boxes = tile(enabled.length);
const LAYOUT = Object.fromEntries(enabled.map((name, i) => [name, boxes[i]]));

async function openWindow(name) {
  const box = LAYOUT[name];
  const dir = path.join(PROFILE_DIR, name);
  // Both of these have to happen with no browser attached to the profile: a
  // running Chrome holds the lock, and it rewrites Preferences as it exits.
  await releaseProfile(dir);
  markProfileClean(dir);
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: null,
    args: [
      `--window-position=${box.x},${box.y}`,
      `--window-size=${box.width},${box.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      // Belt and braces with markProfileClean: if a window ever does go down
      // hard, the next one still must not ask about restoring pages.
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
    ],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { ctx, page };
}

/**
 * Wait until nothing holds `dir`, killing whatever still does.
 *
 * `ctx.close()` resolves before the browser process has finished exiting, and
 * Chrome launched onto a profile another instance still owns just prints
 * "Opening in existing browser session", hands the request to the old process
 * and exits — Playwright then drives a window that was never created, so the
 * search lands nowhere. The lock also survives a run that was killed outright,
 * so this doubles as startup cleanup.
 */
async function releaseProfile(dir) {
  // Ask about the process, not the lock files: Chrome can still own a profile
  // after SingletonLock is gone, and a run that was killed leaves the lock
  // behind with no owner. Neither file answers "is anyone using this?".
  const owners = () => {
    try {
      return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${dir}`], { encoding: 'utf8' }).trim().split('\n');
    } catch {
      return []; // pgrep exits non-zero when nothing matches
    }
  };
  const settle = async (ms) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
      if (!owners().length) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return !owners().length;
  };

  if (await settle(T)) return;
  for (const signal of ['-TERM', '-KILL']) {
    try {
      execFileSync('pkill', [signal, '-f', '--', `--user-data-dir=${dir}`]);
    } catch {}
    if (await settle(T / 2)) break;
  }
  // Whatever is left is a lock with no live owner, which Chrome would honour.
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * Chrome shows "Restore pages?" when the last run of a profile did not record a
 * clean shutdown, and a closed persistent context does not always leave those
 * flags tidy. Rewrite them so the next launch opens a plain window.
 */
function markProfileClean(dir) {
  const edit = (rel, fn) => {
    const file = path.join(dir, rel);
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      fn(json);
      fs.writeFileSync(file, JSON.stringify(json));
    } catch {} // profile not written yet — nothing stale to clear either
  };
  edit('Default/Preferences', (j) => {
    j.profile ??= {};
    j.profile.exit_type = 'Normal';
    j.profile.exited_cleanly = true;
  });
  edit('Local State', (j) => {
    j.user_experience_metrics ??= {};
    j.user_experience_metrics.stability ??= {};
    j.user_experience_metrics.stability.exited_cleanly = true;
  });
}

/** The first frame (main one included) that actually holds `selector`. */
async function findInput(page, selector) {
  const deadline = Date.now() + T;
  do {
    for (const frame of page.frames()) {
      const el = frame.locator(selector).first();
      if (await el.count().then((c) => c > 0).catch(() => false)) return el;
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  throw new Error(`no ${selector} on the page`);
}

/** Baidu drives its result view from an iframe, so check every frame's URL. */
async function waitForResult(page, done, timeout) {
  const deadline = Date.now() + timeout;
  do {
    if (page.frames().some((f) => done.test(f.url()))) return true;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Upload `file` and wait until the page actually navigates to `done`.
 *
 * The sites bind their change handler after the <input> is already in the
 * DOM, so a setInputFiles that lands too early is silently swallowed and the
 * page just sits on the drop pane. Re-setting the file re-fires change, so we
 * retry until the result URL appears.
 */
async function upload(page, file, { input, trigger, done, attempts = 3 }) {
  const el = await findInput(page, input);
  // The input is in the DOM before its change handler is bound; let the page
  // settle first so the common case takes on the very first try.
  await page.waitForLoadState('load', { timeout: T }).catch(() => {});
  await page.waitForTimeout(1200);

  for (let i = 0; i < attempts; i++) {
    try {
      await el.setInputFiles(file, { timeout: T });
    } catch {
      if (!trigger) throw new Error('file input went away');
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: T }),
        page.locator(trigger).first().click(),
      ]);
      await chooser.setFiles(file);
    }
    if (await waitForResult(page, done, T / 2)) return;
    // Handler wasn't listening yet — settle, then fire it again.
    await page.waitForTimeout(800);
  }
  throw new Error(`upload did not take after ${attempts} attempts`);
}

async function searchTinEye(page, file) {
  await page.goto('https://tineye.com/', { waitUntil: 'domcontentloaded' });
  await dismissCookies(page, ['button:has-text("Accept")', 'button:has-text("Got it")']);
  await upload(page, file, {
    input: 'input[type=file]',
    trigger: 'button:has-text("Upload"), label:has-text("Upload")',
    done: /tineye\.com\/(search|result)/,
  });
}

async function searchGoogle(page, file) {
  await page.goto('https://lens.google.com/upload?ep=gisbubb&hl=en', { waitUntil: 'domcontentloaded' });
  await dismissCookies(page, ['button:has-text("Accept all")', 'button:has-text("Reject all")']);
  await upload(page, file, {
    // Lens redirects to google.com/?olud, whose DOM holds three file inputs.
    // Only `encoded_image` is wired to the search; the others swallow the file
    // silently, so this must not be loosened to a bare input[type=file].
    input: 'input[name=encoded_image]',
    trigger: 'text=/upload a file|browse|Drag an image/i',
    done: /google\.com\/search\?/,
  });
  const crop = await expandLensCrop(page);
  const tab = await showExactMatches(page);
  return `crop ${crop}, ${tab ? 'Exact matches' : 'tab not found'}`;
}

async function searchYandex(page, file) {
  await page.goto('https://yandex.com/images/', { waitUntil: 'domcontentloaded' });
  await dismissCookies(page, [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Принять")',
  ]);
  // The upload input only exists once the camera panel is open on some builds,
  // so open it first and let `upload` retry if it is still being wired up.
  await page
    .locator('[class*=CbirButton], button[aria-label*="image" i], .input__button_type_cbir')
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  await upload(page, file, {
    input: 'input[type=file]',
    trigger: '[class*=CbirButton], button[aria-label*="image" i]',
    done: /yandex\.[a-z.]+\/images\/search/,
  });
  // A captcha here still counts as a navigation, so say what actually landed.
  return (await page.locator('text=/are not a robot|captcha/i').first().isVisible({ timeout: 1500 }).catch(() => false))
    ? 'captcha — solve it in the window'
    : undefined;
}

async function searchBaidu(page, file) {
  await page.goto('https://graph.baidu.com/pcpage/index?tpl_from=pc', { waitUntil: 'domcontentloaded' });
  await upload(page, file, {
    input: 'input[type=file]',
    trigger: 'text=/本地上传|上传图片|Upload/i',
    done: /graph\.baidu\.com\/(s\?|pcpage\/(similar|same)|sc\?)/,
  });
}

/**
 * Bing no longer has a standalone image-match view: an upload identifies the
 * subject and drops you on a normal web SERP for it, tagged with a `bcid` (the
 * id of the uploaded image) and a FORM=SBI* source. That SERP is the result.
 *
 * `bing.com/visualsearch` redirects to a Microsoft marketing page, so go
 * through the images upload pane instead.
 */
async function searchBing(page, file) {
  await page.goto('https://www.bing.com/images/search?view=detailv2&iss=sbiupload', {
    waitUntil: 'domcontentloaded',
  });
  await dismissCookies(page, [
    '#bnp_btn_accept',
    'button:has-text("Accept")',
    'button:has-text("Accept all")',
  ]);
  await upload(page, file, {
    input: 'input[type=file]',
    trigger: 'label[for=sb_fileinput], text=/browse|Drag (an|one) image|paste/i',
    // Must not be loosened to a bare FORM=SBI: the upload pane itself lands on
    // /images?FORM=SBIRDI, which would read as a result before anything ran.
    done: /bing\.com\/(search|images\/search)\?.*(FORM=SBI|insightstoken)/i,
  });
  // Bing's guess at the subject is the whole answer here, so surface it.
  const q = new URL(page.url()).searchParams.get('q');
  return q ? `“${q}”` : undefined;
}

/**
 * Lens auto-crops to whatever object it detected. Re-run the search on the
 * whole image instead, by rewriting the crop in the URL and loading it once.
 *
 * The result URL's `vsint` is a base64url protobuf whose crop box is four
 * floats — centre x, centre y, width, height, as fractions of the image —
 * tagged 0x0d/0x15/0x1d/0x25 in a row. Its first field says where the box came
 * from: 2 is the initial load (which Lens then auto-crops), 4 a user's crop,
 * which Lens leaves alone. So: mark it a user crop of 0.5/0.5/1/1.
 *
 * This replaces dragging the corner guides, which re-searched on every drag,
 * collapsed the crop UI after each one, and could not reach a bottom edge
 * below the fold.
 */
async function expandLensCrop(page) {
  const crop = () =>
    page.evaluate(() => {
      const pct = {};
      for (const i of document.querySelectorAll('input[type=range][aria-label]')) {
        // e.g. "top left corner of search area: left 34%, top 0%"
        for (const [, edge, v] of i.getAttribute('aria-label').matchAll(/(left|right|top|bottom) (\d+)%/g)) pct[edge] = +v;
      }
      return pct;
    });
  // The guides are in the DOM, reading 0% all round, before Lens places them.
  const read = async (ms) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
      const p = await crop();
      if (p.right > p.left && p.bottom > p.top) return p;
      await page.waitForTimeout(250);
    }
    return null;
  };
  const show = (p) => `${p.left}/${p.top}/${p.right}/${p.bottom}`;
  const isFull = (p) => p.left === 0 && p.top === 0 && p.right === 100 && p.bottom === 100;

  const before = await read(T / 2);
  if (!before) return 'no crop UI';
  if (isFull(before)) return 'full frame';

  const url = new URL(page.url());
  const vsint = url.searchParams.get('vsint');
  if (!vsint) return `left at ${show(before)} (no vsint in URL)`;
  const b = Buffer.from(vsint, 'base64url');
  const box = b.findIndex((_, k) => b[k] === 0x0d && b[k + 5] === 0x15 && b[k + 10] === 0x1d && b[k + 15] === 0x25);
  if (b[0] !== 0x08 || box === -1) return `left at ${show(before)} (vsint layout changed)`;
  b[1] = 4;
  [0.5, 0.5, 1, 1].forEach((v, n) => b.writeFloatLE(v, box + 1 + n * 5));
  url.searchParams.set('vsint', b.toString('base64url'));

  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const after = await read(T);
  return after && isFull(after) ? 'full frame' : `left at ${show(after ?? before)}`;
}

/** Switch to the Exact matches tab once the full-image search has settled. */
async function showExactMatches(page) {
  const tab = page
    .getByRole('link', { name: /exact matches/i })
    .or(page.getByRole('button', { name: /exact matches/i }))
    .first();
  return tab
    .click({ timeout: T })
    .then(() => true)
    .catch(() => false);
}

async function dismissCookies(page, selectors) {
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      return;
    }
  }
}

const windows = {};
async function ensureWindows() {
  if (windows.ready) return;
  const opened = await Promise.all(enabled.map((name) => openWindow(name)));
  for (const [i, name] of enabled.entries()) {
    windows[name] = opened[i];
    opened[i].ctx.on('close', () => { windows.ready = false; });
  }
  windows.ready = true;
}

/**
 * Ask every window to shut down. The profile is only certainly free once
 * `releaseProfile` says so, which `openWindow` waits on before relaunching.
 */
async function closeWindows() {
  const open = enabled.map((name) => windows[name]).filter(Boolean);
  windows.ready = false;
  for (const name of enabled) delete windows[name];
  await Promise.all(open.map((w) => w.ctx.close().catch(() => {})));
}

let queue = Promise.resolve();
function enqueue(file) {
  queue = queue.then(() => handle(file)).catch((err) => console.error('  ✗', err.message));
}

async function handle(file) {
  console.log(`\n→ ${path.relative(process.cwd(), file)}`);
  // Every image gets a fresh set of windows: the previous results are of no
  // further use, and reusing a window leaves the old result on screen while the
  // next search loads.
  await closeWindows();
  await ensureWindows();
  const results = await Promise.allSettled(
    enabled.map((name) => ENGINES[name].run(windows[name].page, file)),
  );
  for (const [i, r] of results.entries()) {
    const { label } = ENGINES[enabled[i]];
    if (r.status === 'rejected') console.log(`  ✗ ${label}: ${r.reason.message.split('\n')[0]}`);
    else console.log(`  ✓ ${label}${r.value ? ` (${r.value})` : ''}`);
  }
}

/**
 * One run at a time. Every run shares the same profiles, and `releaseProfile`
 * kills whatever holds them — so a second run would tear down the first one's
 * windows, which then relaunch and tear down the second's.
 */
function claimInstance() {
  const lock = path.join(PROFILE_DIR, '.lock');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      process.on('exit', () => fs.rmSync(lock, { force: true }));
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try {
      process.kill(pid, 0);
      console.error(`Another reverse-search run (pid ${pid}) already owns the browser profiles — stop it first.`);
      process.exit(1);
    } catch (err) {
      if (err.code === 'EPERM') throw err;
      fs.rmSync(lock, { force: true }); // left by a run that was killed outright
    }
  }
}
claimInstance();

if (!fs.existsSync(watchDir)) fs.mkdirSync(watchDir, { recursive: true });

const box = LAYOUT[enabled[0]];
console.log(`Watching ${watchDir} for images  (${screen.width}×${screen.height}, ${box.width}×${box.height} per window)`);
console.log(`Engines: ${enabled.map((n) => ENGINES[n].label).join(', ')}`);
console.log('Ctrl-C to stop.');

chokidar
  .watch(watchDir, {
    depth: 0,
    ignoreInitial: !flags.has('--existing'),
    awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
  })
  .on('add', (file) => {
    if (IMAGE_EXT.has(path.extname(file).toLowerCase())) enqueue(path.resolve(file));
  });

process.on('SIGINT', async () => {
  await closeWindows();
  process.exit(0);
});
