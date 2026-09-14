const PATHS = {
  verify: '/fan2/verify/verify',
  checkVerification: '/fan2/verify/check-verification',
  confirm: '/fan2/verify/confirm',
};

const DEFAULT_API_BASE = 'https://api.openstage.live';
const DEFAULT_CHANNEL_TYPE = 'Registration Page';
const DEFAULT_LOCALE = 'en';

const apiBase = (config) => config.api_base || DEFAULT_API_BASE;
const locale = (config) => config.locale || DEFAULT_LOCALE;
const consentEmail = (config) => config.consent_email !== false;

// The API lives on api.openstage.live while the page is served from the
// registration domain, so every call is cross-site and needs the page's
// origin/referer. Both are derived from return_url unless overridden.
function apiHeaders(config) {
  const origin = new URL(config.return_url).origin;
  return {
    origin,
    referer: config.referrer || `${origin}/`,
    'sec-fetch-site': 'cross-site',
  };
}

/**
 * Step 1 – asks the backend to email a magic link to the address.
 * Mirrors the site's own /verify request; no captcha is required here.
 */
async function sendVerify(session, config, { email }) {
  const res = await session.postJson(
    apiBase(config) + PATHS.verify,
    {
      returnUrl: config.return_url,
      artistId: config.artist_id,
      pageId: config.page_id,
      locale: locale(config),
      type: 'email',
      email,
      data: {
        tags: [],
        pollAnswerIds: [],
        consentEmail: consentEmail(config),
        acquisition: {
          channelName: config.channel_name,
          channelType: config.channel_type || DEFAULT_CHANNEL_TYPE,
          referrer: null,
          pageId: config.page_id,
        },
      },
    },
    apiHeaders(config)
  );

  if (res.status !== 'OK') {
    throw new Error(`/verify did not return OK: ${JSON.stringify(res)}`);
  }
  return res;
}

/**
 * Step 2 – exchanges the token from the email link (type "email") for the
 * session token carrying emailValid:true, which /confirm requires. This is the
 * call the page's SPA fires on load; a headless client has to replay it.
 */
async function checkVerification(session, config, emailToken) {
  const params = new URLSearchParams({
    token: emailToken,
    artistId: config.artist_id,
    pageId: config.page_id,
  });
  const url = `${apiBase(config)}${PATHS.checkVerification}?${params}`;
  const res = await session.getJson(url, apiHeaders(config));

  if (!res || !res.token) {
    throw new Error(`/check-verification returned no token: ${JSON.stringify(res)}`);
  }
  return res.token;
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Builds the poll answers for /confirm. The city poll is a ranked pick-N: the
 * top-ranked city goes into the main poll, and each further rank maps to one of
 * the "preference" polls via that city's preferencePollAnswerIds (index i lines
 * up with preferencePollIds[i]). Non-city polls (travel, album quiz) are fixed.
 * Cities are chosen fresh per registration so each signup ranks a random set.
 */
function buildPollAnswers(config) {
  const cities = config.polls.cities;
  const pick = Math.max(1, cities.pick || 1);
  const chosen = shuffle(cities.options).slice(0, pick);
  const [first, ...rest] = chosen;

  const journeyPollAnswers = [...(config.polls.fixed || [])];
  rest.forEach((city, i) => {
    const prefPollId = cities.preferencePollIds[i];
    const prefAnswer = city.preferencePollAnswerIds && city.preferencePollAnswerIds[i];
    if (prefPollId && prefAnswer) {
      journeyPollAnswers.push({ pollId: prefPollId, pollAnswerIds: [prefAnswer] });
    }
  });

  return {
    pollId: cities.pollId,
    pollAnswerIds: [first.pollAnswerId],
    journeyPollAnswers,
    chosen: chosen.map(c => c.venue),
  };
}

/**
 * Step 3 – completes the registration. `token` is the emailValid token from
 * checkVerification, `captcha` is the reCAPTCHA Enterprise response and `polls`
 * comes from buildPollAnswers.
 */
async function confirm(session, config, { token, captcha, location, ip, profile, polls }) {
  const res = await session.postJson(
    apiBase(config) + PATHS.confirm,
    {
      location,
      captcha,
      consentEmail: consentEmail(config),
      countryCallingCode: profile.countryCallingCode,
      nationalPhoneNumber: profile.nationalPhoneNumber,
      firstName: profile.firstName,
      lastName: profile.lastName,
      dateOfBirth: profile.dateOfBirth,
      journeyPollAnswers: polls.journeyPollAnswers,
      pollAnswerIds: polls.pollAnswerIds,
      artistId: config.artist_id,
      ip,
      locale: locale(config),
      pageId: config.page_id,
      pollId: polls.pollId,
      tags: config.tags || [],
      token,
      url: `${config.return_url}?token=${token}`,
    },
    apiHeaders(config)
  );

  if (res.status !== 'OK') {
    throw new Error(`/confirm did not return OK: ${JSON.stringify(res)}`);
  }
  return res;
}

module.exports = { sendVerify, checkVerification, confirm, buildPollAnswers };
