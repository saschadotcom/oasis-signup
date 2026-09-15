const human = require('./human');

const SEL = {
  email: '#soundcheckEmail',
  consentEmail: '#consentEmail',
  firstName: '#soundcheckConfirmFirstName',
  lastName: '#soundcheckConfirmLastName',
  birthDate: '#birthDate',
  location: '#soundcheckConfirmLocation',
  phone: '#soundcheckConfirmPhoneNumber',
  firstChoice: '#soundcheckEventSelect',
  nthChoice: n => `#soundcheckTourPreference-${n}`,
  journeyPoll: '[role=combobox][id^="soundcheckJourneyPoll-"]',
  calendar: '[data-testid=calendar]',
  monthSelect: '#month',
  yearSelect: '#year',
  dayCell: iso => `[data-reka-calendar-cell-trigger][data-value="${iso}"]`,
  termsScroller: '.terms-gate__scroller',
  option: '[role=option]',
  pickMark: '[data-oasis-pick="1"]',
};

const FORWARD = /^(weiter|next|continue|fortfahren)$/i;
const SUBMIT = /^(absenden|submit|anmelden|sign up|register|registrieren)$/i;
// Placeholders across locales all end in an ellipsis ("Option auswählen…",
// "Select option..."), which is a language-independent "not answered yet" test.
const UNANSWERED = /(\.\.\.|…)\s*$/;

const normalize = s => String(s || '').toLowerCase().replace(/[’'`´]/g, "'").replace(/\s+/g, ' ').trim();

async function exists(page, selector) {
  return (await page.$(selector)) !== null;
}

async function waitFor(page, selector, timeout = 30000) {
  await page.waitForSelector(selector, { visible: true, timeout });
}

function visibleFilter() {
  return el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
}

// Clicking a listbox entry needs a real pointer event, so the target is tagged
// in the DOM first and then clicked through the human mouse helpers.
async function clickMarked(page, state) {
  await human.click(page, SEL.pickMark, state);
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach(el => el.removeAttribute('data-oasis-pick'));
  }, SEL.pickMark);
}

async function listOptions(page) {
  return page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...document.querySelectorAll('[role=option]')].filter(vis).map(el => String(el.innerText || '').trim());
  });
}

/** Opens a combobox and clicks the option chosen by `choose(texts) -> index`. */
async function pickFromCombobox(page, state, trigger, choose, label) {
  await human.click(page, trigger, state);
  await waitFor(page, SEL.option, 15000);
  await human.think(250, 900);

  const texts = await listOptions(page);
  const index = choose(texts);
  if (index === -1 || index === undefined || index === null) {
    await page.keyboard.press('Escape');
    throw new Error(`no matching option for ${label}; available: ${texts.join(' | ').slice(0, 300)}`);
  }

  const picked = await page.evaluate((i) => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const opts = [...document.querySelectorAll('[role=option]')].filter(vis);
    if (!opts[i]) return null;
    opts[i].setAttribute('data-oasis-pick', '1');
    return String(opts[i].innerText || '').trim();
  }, index);
  if (!picked) throw new Error(`option ${index} vanished for ${label}`);

  await clickMarked(page, state);
  await human.think(400, 1200);
  return picked;
}

async function clickButtonByText(page, state, pattern, { required = true } = {}) {
  const found = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const btn = [...document.querySelectorAll('button')].filter(vis)
      .find(b => re.test(String(b.innerText || '').trim()));
    if (!btn) return null;
    if (btn.disabled) return { disabled: true, text: btn.innerText.trim() };
    btn.setAttribute('data-oasis-pick', '1');
    return { disabled: false, text: btn.innerText.trim() };
  }, pattern.source);

  if (!found) {
    if (required) throw new Error(`button not found: ${pattern}`);
    return null;
  }
  if (found.disabled) throw new Error(`button "${found.text}" is disabled`);

  await clickMarked(page, state);
  return found.text;
}

/** Step 1 of the site: request the magic link for `email`. */
async function requestVerification(page, state, { url, email }) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await waitFor(page, SEL.email, 60000);
  await human.think(800, 2200);
  await human.skim(page, state);

  await human.type(page, SEL.email, email, state);
  await human.maybeDistract(page);

  const consentOff = await page.$eval(SEL.consentEmail, el => el.getAttribute('data-state') !== 'checked').catch(() => false);
  if (consentOff) {
    await human.click(page, SEL.consentEmail, state);
    await human.think(300, 900);
  }

  await clickButtonByText(page, state, /^(los geht's|get started|continue|weiter|submit)$/i);
  await page.waitForFunction(
    () => /überprüfe deine e-mails|check your email|check your inbox/i.test(document.body.innerText),
    { timeout: 60000 },
  );
}

/** Picks a date in the Reka calendar: year, then month, then the exact day cell. */
async function setBirthDate(page, state, iso) {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`invalid DateOfBirth "${iso}" (expected YYYY-MM-DD)`);

  await human.click(page, SEL.birthDate, state);
  await waitFor(page, SEL.calendar, 20000);
  await human.think(400, 1100);

  if (!await exists(page, SEL.dayCell(iso))) {
    await pickFromCombobox(page, state, SEL.yearSelect,
      texts => texts.findIndex(t => t.trim() === String(year)), `year ${year}`);
    // Month options are ordered January..December, so the index is locale-proof.
    await pickFromCombobox(page, state, SEL.monthSelect, texts => (texts.length >= 12 ? month - 1 : -1), `month ${month}`);
  }

  await waitFor(page, SEL.dayCell(iso), 15000);
  await human.click(page, SEL.dayCell(iso), state);
  await human.think(400, 1100);

  const value = await page.$eval(SEL.birthDate, el => el.value).catch(() => '');
  if (!value) throw new Error('birth date did not stick');
  return value;
}

/** The location field is a search-as-you-type combobox; pick a real suggestion. */
async function setLocation(page, state, city) {
  await human.type(page, SEL.location, city, state);
  await human.think(900, 2000);

  try {
    await waitFor(page, SEL.option, 15000);
  } catch {
    throw new Error(`no location suggestions for "${city}"`);
  }
  const texts = await listOptions(page);
  const idx = texts.findIndex(t => normalize(t).includes(normalize(city))) ;
  const chosen = await page.evaluate((i) => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const opts = [...document.querySelectorAll('[role=option]')].filter(vis);
    const el = opts[i] || opts[0];
    if (!el) return null;
    el.setAttribute('data-oasis-pick', '1');
    return String(el.innerText || '').trim();
  }, idx === -1 ? 0 : idx);
  if (!chosen) throw new Error(`no location suggestion clickable for "${city}"`);

  await clickMarked(page, state);
  await human.think(400, 1000);
  return chosen;
}

async function fillPersonalStep(page, state, { profile, city, log }) {
  await human.think(700, 1800);

  const firstName = await page.$eval(SEL.firstName, el => el.value).catch(() => '');
  if (normalize(firstName) !== normalize(profile.firstName)) {
    await human.type(page, SEL.firstName, profile.firstName, state);
  }
  const lastName = await page.$eval(SEL.lastName, el => el.value).catch(() => '');
  if (normalize(lastName) !== normalize(profile.lastName)) {
    await human.type(page, SEL.lastName, profile.lastName, state);
  }
  await human.maybeDistract(page);

  const dob = await page.$eval(SEL.birthDate, el => el.value).catch(() => '');
  if (!dob) {
    const set = await setBirthDate(page, state, profile.dateOfBirth);
    log(`birth date set to "${set}"`);
  }

  const loc = await page.$eval(SEL.location, el => el.value).catch(() => '');
  if (!loc) {
    const set = await setLocation(page, state, city);
    log(`location set to "${set}"`);
  } else {
    log(`location prefilled: "${loc}"`);
  }

  const phone = await page.$eval(SEL.phone, el => el.value).catch(() => '');
  if (normalize(phone) !== normalize(profile.nationalPhoneNumber)) {
    await human.type(page, SEL.phone, profile.nationalPhoneNumber, state);
  }

  // The dial code is derived from the profile's country; warn on a mismatch
  // instead of silently registering with the wrong prefix.
  if (profile.countryCallingCode) {
    const shown = await page.evaluate(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const el = [...document.querySelectorAll('button,span,div')].filter(vis)
        .find(e => /^\+\d{1,4}$/.test(String(e.innerText || '').trim()));
      return el ? el.innerText.trim() : null;
    });
    if (shown && shown !== `+${profile.countryCallingCode}`) {
      log(`WARNING dial code on page is ${shown}, CSV says +${profile.countryCallingCode}`);
    }
  }

  await human.think(600, 1600);
}

async function pickCitiesStep(page, state, { venues, log }) {
  for (let i = 0; i < venues.length; i++) {
    const trigger = i === 0 ? SEL.firstChoice : SEL.nthChoice(i + 1);
    if (!await exists(page, trigger)) {
      log(`no selector for choice ${i + 1}, stopping city selection`);
      break;
    }
    const venue = venues[i];
    const picked = await pickFromCombobox(page, state, trigger,
      texts => texts.findIndex(t => normalize(t).includes(normalize(venue))), `city "${venue}"`);
    log(`choice ${i + 1}: ${picked.replace(/\n/g, ' ')}`);
    await human.maybeDistract(page, 0.08);
  }
}

/**
 * Answers every journey poll still showing a placeholder. If the configured quiz
 * answer is among the options it wins (the album question has one correct
 * answer); otherwise an option is chosen at random for natural variety.
 */
async function answerPollsStep(page, state, { quizAnswer, log }) {
  for (let guard = 0; guard < 8; guard++) {
    const pending = await page.evaluate((sel, unanswered) => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const re = new RegExp(unanswered);
      const el = [...document.querySelectorAll(sel)].filter(vis)
        .find(e => re.test(String(e.innerText || '').trim()));
      return el ? el.id : null;
    }, SEL.journeyPoll, UNANSWERED.source);

    if (!pending) return;

    const wanted = normalize(quizAnswer);
    const picked = await pickFromCombobox(page, state, `[id="${pending}"]`, (texts) => {
      const exact = texts.findIndex(t => normalize(t) === wanted);
      if (exact !== -1) return exact;
      const partial = texts.findIndex(t => wanted && normalize(t).includes(wanted));
      if (partial !== -1) return partial;
      return human.randInt(0, texts.length - 1);
    }, `poll ${pending}`);
    log(`poll answered: ${picked.replace(/\n/g, ' ')}`);
  }
}

async function acceptTermsStep(page, state, { log }) {
  if (await exists(page, SEL.termsScroller)) {
    const reached = await human.scrollToBottom(page, SEL.termsScroller, state);
    log(reached ? 'terms scrolled to the end' : 'terms scroll did not reach the end');
    await human.think(700, 1800);
  }
  const label = await clickButtonByText(page, state, SUBMIT);
  log(`submitted via "${label}"`);
}

/**
 * Walks the multi-step form. Each pass looks at what is actually on screen
 * instead of assuming a fixed order, so an extra poll or a reordered step does
 * not break the run.
 */
async function completeRegistration(page, state, opts) {
  const { log, isDone } = opts;

  for (let step = 0; step < 14; step++) {
    if (isDone()) return;
    await human.think(500, 1400);

    if (await exists(page, SEL.firstName)) {
      log('step: personal details');
      await fillPersonalStep(page, state, opts);
      await clickButtonByText(page, state, FORWARD);
    } else if (await exists(page, SEL.firstChoice)) {
      log('step: city preferences');
      await pickCitiesStep(page, state, opts);
      await answerPollsStep(page, state, opts);
      await clickButtonByText(page, state, FORWARD);
    } else if (await exists(page, SEL.journeyPoll)) {
      log('step: poll');
      await answerPollsStep(page, state, opts);
      await clickButtonByText(page, state, FORWARD);
    } else if (await exists(page, SEL.termsScroller) || await hasSubmit(page)) {
      log('step: terms & conditions');
      await acceptTermsStep(page, state, opts);
      await page.waitForFunction(
        () => /danke für deine registrierung|thanks for registering|thank you for registering/i.test(document.body.innerText),
        { timeout: 90000 },
      ).catch(() => {});
      return;
    } else {
      const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, ' | ').slice(0, 300));
      throw new Error(`unrecognised step: ${text}`);
    }

    await human.think(1200, 2600);
  }
  throw new Error('form did not finish within the expected number of steps');
}

async function hasSubmit(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...document.querySelectorAll('button')].filter(vis).some(b => re.test(String(b.innerText || '').trim()));
  }, SUBMIT.source);
}

module.exports = { SEL, requestVerification, completeRegistration, normalize };
