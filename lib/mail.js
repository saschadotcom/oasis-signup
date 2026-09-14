// Token extraction helpers for the verification email. The IMAP side lives in
// mailbox.js; this module only turns a mail body into the JWT token(s) it holds.

const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Oasis mails a magic link (…/registration?token=<JWT>). Links are often wrapped
// by the mail provider (Outlook safelinks), so the token appears URL-encoded
// (token%3D…) and/or plain (originalsrc=…). Collect every JWT-shaped candidate.
function tokenCandidates(raw) {
  const set = new Set();
  for (const m of raw.matchAll(/token=([A-Za-z0-9._-]+)/g)) set.add(m[1]);
  for (const m of raw.matchAll(/token%3D([A-Za-z0-9._-]+)/gi)) {
    try { set.add(decodeURIComponent(m[1])); } catch { /* ignore */ }
  }
  return [...set].filter(t => JWT.test(t));
}

// Every (token, email) pair in a body, with the email read from the JWT payload
// so a shared/catch-all inbox can be routed to the right recipient precisely.
function extractAllTokens(raw) {
  return tokenCandidates(raw).map(token => {
    const payload = decodeJwtPayload(token);
    return { token, email: payload && payload.email ? String(payload.email).toLowerCase() : null };
  });
}

// Best token for a specific recipient (email-match first, else longest JWT).
function extractToken(raw, email) {
  const cands = tokenCandidates(raw);
  if (cands.length === 0) return null;

  if (email) {
    const wanted = email.toLowerCase();
    const match = cands.find(t => {
      const p = decodeJwtPayload(t);
      return p && String(p.email || '').toLowerCase() === wanted;
    });
    if (match) return match;
  }

  return cands.sort((a, b) => b.length - a.length)[0];
}

module.exports = { extractToken, extractAllTokens, decodeJwtPayload };
