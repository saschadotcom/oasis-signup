// Human-like input for puppeteer. Every helper randomises its own timing and
// geometry, so no two tasks produce the same trace of events – the point is that
// a few thousand signups must not look like one script run N times.

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const chance = p => Math.random() < p;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Slightly bell-shaped instead of flat: most delays land mid-range, a few are
// noticeably slower, which is how real typing/pausing is distributed.
function jitter(min, max) {
  const t = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.round(min + t * (max - min));
}

const think = (min = 400, max = 1400) => sleep(jitter(min, max));

// Occasional longer "distraction" pause, as if the user looked away.
async function maybeDistract(page, p = 0.12) {
  if (chance(p)) await sleep(jitter(1200, 3500));
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

/**
 * Moves the pointer along a slightly curved path with a variable number of
 * steps. A straight, constant-speed line is one of the cheapest automation
 * tells, so the path bows to one side and overshoots now and then.
 */
async function moveMouse(page, toX, toY, state) {
  const from = state.mouse || { x: rand(80, 400), y: rand(80, 400) };
  const steps = randInt(14, 32);
  const bow = rand(-60, 60);
  const dx = toX - from.x;
  const dy = toY - from.y;

  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps);
    // perpendicular offset gives the path its curve, fading out at both ends
    const curve = Math.sin(Math.PI * (i / steps)) * bow;
    const nx = from.x + dx * t - (dy / (Math.hypot(dx, dy) || 1)) * curve;
    const ny = from.y + dy * t + (dx / (Math.hypot(dx, dy) || 1)) * curve;
    await page.mouse.move(nx + rand(-1.2, 1.2), ny + rand(-1.2, 1.2));
    if (chance(0.15)) await sleep(jitter(8, 40));
  }

  // small settle / correction move, like a hand coming to rest
  if (chance(0.55)) {
    await page.mouse.move(toX + rand(-3, 3), toY + rand(-3, 3));
    await sleep(jitter(20, 90));
  }
  await page.mouse.move(toX, toY);
  state.mouse = { x: toX, y: toY };
}

async function elementBox(page, selector, state) {
  const handle = await page.$(selector);
  if (!handle) throw new Error(`element not found: ${selector}`);

  // Prefer real wheel input to reach the element; fall back to a programmatic
  // scroll only if it stays out of view (e.g. inside a nested scroller).
  if (state) await bringIntoView(page, selector, state);
  const inView = await handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  if (!inView) {
    await handle.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await sleep(jitter(250, 700));
  }

  const box = await handle.boundingBox();
  if (!box) throw new Error(`element not visible: ${selector}`);
  return { handle, box };
}

// Clicks a random point in the inner area of the element rather than its exact
// centre, which is what a mouse-driven click looks like.
async function click(page, selector, state) {
  const { box } = await elementBox(page, selector, state);
  const x = box.x + rand(box.width * 0.3, box.width * 0.7);
  const y = box.y + rand(box.height * 0.3, box.height * 0.7);

  await moveMouse(page, x, y, state);
  await sleep(jitter(60, 260));
  await page.mouse.down();
  await sleep(jitter(35, 120));
  await page.mouse.up();
  await sleep(jitter(150, 500));
}

/**
 * Types into a field with per-character delays, an occasional typo that gets
 * corrected, and a pause or two mid-word. Existing content is removed the way a
 * user would: select-all, then delete.
 */
async function type(page, selector, text, state) {
  await click(page, selector, state);

  const existing = await page.$eval(selector, el => el.value || '').catch(() => '');
  if (existing) {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await sleep(jitter(80, 220));
    await page.keyboard.press('Backspace');
    await sleep(jitter(120, 350));
  }

  const chars = [...String(text)];
  for (let i = 0; i < chars.length; i++) {
    // fat-finger a neighbouring character, notice it, fix it
    if (chance(0.03) && /[a-z]/i.test(chars[i])) {
      const neighbours = 'qwertyuiopasdfghjklzxcvbnm';
      await page.keyboard.type(neighbours[randInt(0, neighbours.length - 1)]);
      await sleep(jitter(140, 420));
      await page.keyboard.press('Backspace');
      await sleep(jitter(90, 260));
    }

    await page.keyboard.type(chars[i]);
    await sleep(jitter(45, 190));

    if (chance(0.06)) await sleep(jitter(300, 900)); // brief hesitation
  }
  await sleep(jitter(200, 600));
}

/**
 * Draws a cursor overlay that follows the synthetic pointer. CDP mouse events
 * never move the real OS cursor, so without this you see nothing happening.
 * Debug aid only – it injects an element into the page, so keep it off for
 * production runs (config: browser.show_cursor).
 */
async function installCursor(page) {
  await page.evaluateOnNewDocument(() => {
    const install = () => {
      if (!document.body) return requestAnimationFrame(install);
      if (document.querySelector('[data-hh-cursor]')) return;

      const dot = document.createElement('div');
      dot.setAttribute('data-hh-cursor', '');
      dot.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'width:20px', 'height:20px',
        'margin:-10px 0 0 -10px', 'border-radius:50%',
        'border:2px solid rgba(255,64,64,.95)', 'background:rgba(255,64,64,.22)',
        'box-shadow:0 0 8px rgba(255,64,64,.5)', 'pointer-events:none',
        'z-index:2147483647', 'transition:width .08s,height .08s,background .08s',
      ].join(';');
      document.body.appendChild(dot);

      let x = 0, y = 0, pressed = false;
      const render = () => {
        dot.style.transform = `translate(${x}px, ${y}px) scale(${pressed ? 0.65 : 1})`;
      };
      addEventListener('mousemove', e => { x = e.clientX; y = e.clientY; render(); }, true);
      addEventListener('mousedown', () => {
        pressed = true;
        dot.style.background = 'rgba(64,160,255,.35)';
        render();
      }, true);
      addEventListener('mouseup', () => {
        pressed = false;
        dot.style.background = 'rgba(255,64,64,.22)';
        render();
      }, true);
    };
    install();
  });
}

function scrollMetrics(selector) {
  return page => page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : document.scrollingElement;
    if (!el) return null;
    return {
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
      atBottom: el.scrollTop >= el.scrollHeight - el.clientHeight - 4,
    };
  }, selector);
}

/**
 * One wheel "flick": a handful of ticks that ramp up and ease out again, the way
 * a finger rolls a wheel or swipes a trackpad. Real wheel events are dispatched,
 * so the page sees genuine input instead of a scrollTop assignment.
 */
async function wheelFlick(page, { peak = rand(90, 220), up = false } = {}) {
  const ticks = randInt(3, 9);
  for (let t = 1; t <= ticks; t++) {
    const shape = Math.sin(Math.PI * (t / (ticks + 1))); // ramp in, ease out
    const delta = Math.max(10, Math.round(peak * shape));
    await page.mouse.wheel({ deltaY: up ? -delta : delta });
    await sleep(jitter(10, 45));
  }
}

/**
 * Scrolls an element (or the window) to its end using real wheel input, with
 * pauses, the odd flick back up, and a scrollTop fallback if wheel events do not
 * move the container (so a quirky layout can never hang the run).
 */
async function scrollToBottom(page, selector, state, { maxFlicks = 200 } = {}) {
  const metrics = scrollMetrics(selector);

  if (selector) {
    // Park the pointer over the scrollable area – wheel events go to whatever
    // element is under the cursor.
    try {
      const handle = await page.$(selector);
      const box = handle && await handle.boundingBox();
      if (box) {
        await moveMouse(
          page,
          box.x + box.width * rand(0.35, 0.65),
          box.y + box.height * rand(0.35, 0.65),
          state,
        );
      }
    } catch { /* fall through to wheel/fallback anyway */ }
  }

  let stalled = 0;
  for (let i = 0; i < maxFlicks; i++) {
    const before = await metrics(page);
    if (!before) return false;
    if (before.atBottom) return true;

    await wheelFlick(page);
    await sleep(jitter(110, 420));

    if (chance(0.07)) { // glance back at something
      await wheelFlick(page, { peak: rand(40, 110), up: true });
      await sleep(jitter(250, 800));
    }
    if (chance(0.05)) await sleep(jitter(700, 2100)); // stop and read

    const after = await metrics(page);
    if (!after) return false;
    if (after.atBottom) return true;

    if (after.top <= before.top + 2) {
      stalled++;
      if (stalled >= 3) {
        // Wheel input is not reaching this container; nudge it directly instead.
        await page.evaluate((sel) => {
          const el = sel ? document.querySelector(sel) : document.scrollingElement;
          if (el) el.scrollTop += 140 + Math.random() * 220;
        }, selector);
        await sleep(jitter(120, 380));
      }
    } else {
      stalled = 0;
    }
  }
  return (await metrics(page))?.atBottom === true;
}

// Brings an element into view by scrolling the window with wheel input rather
// than jumping there programmatically.
async function bringIntoView(page, selector, state) {
  for (let i = 0; i < 25; i++) {
    const where = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.top >= vh * 0.15 && r.bottom <= vh * 0.85) return { ok: true };
      return { ok: false, below: r.top > vh * 0.5, distance: Math.abs(r.top - vh * 0.45) };
    }, selector);

    if (!where) return false;
    if (where.ok) return true;

    await wheelFlick(page, { peak: Math.min(240, Math.max(60, where.distance * 0.5)), up: !where.below });
    await sleep(jitter(90, 280));
  }
  return true;
}

// Tiny aimless pointer drift, as happens while reading.
async function idle(page, state, { moves = randInt(1, 3) } = {}) {
  const vp = page.viewport() || { width: 1280, height: 800 };
  for (let i = 0; i < moves; i++) {
    const from = state.mouse || { x: vp.width / 2, y: vp.height / 2 };
    await moveMouse(
      page,
      Math.min(vp.width - 5, Math.max(5, from.x + rand(-120, 120))),
      Math.min(vp.height - 5, Math.max(5, from.y + rand(-90, 90))),
      state,
    );
    await sleep(jitter(200, 900));
  }
}

// A short skim of the page before interacting with it.
async function skim(page, state) {
  await sleep(jitter(400, 1200));
  const rounds = randInt(1, 3);
  for (let i = 0; i < rounds; i++) {
    await wheelFlick(page, { peak: rand(80, 200) });
    await sleep(jitter(300, 1100));
  }
  if (chance(0.6)) {
    await wheelFlick(page, { peak: rand(50, 140), up: true });
    await sleep(jitter(250, 800));
  }
  await idle(page, state);
}

module.exports = {
  rand, randInt, chance, sleep, jitter, think, maybeDistract,
  moveMouse, click, type, scrollToBottom, bringIntoView, skim, idle,
  installCursor, wheelFlick,
};
