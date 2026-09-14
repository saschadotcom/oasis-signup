// The /confirm payload carries the visitor's public IP and a coarse location.
// The real site fills these from the browser (IP + reverse geocode); a headless
// client derives them from the outbound proxy IP via a geo-IP lookup so both
// match the address the request actually comes from.
//
// Residential/mobile proxy IPs are frequently rate-limited or flagged by a
// single geo-IP provider, so we try a few in order before giving up.

function normalizeIpwho(d) {
  if (!d || d.success === false || !d.ip) return null;
  return {
    ip: d.ip,
    location: {
      latitude: d.latitude,
      longitude: d.longitude,
      city: d.city || '',
      county: d.region || '',
      country: d.country || '',
      countryCode: d.country_code || '',
      state: d.region || '',
    },
  };
}

function normalizeIpapiCo(d) {
  if (!d || d.error || !d.ip) return null;
  return {
    ip: d.ip,
    location: {
      latitude: d.latitude,
      longitude: d.longitude,
      city: d.city || '',
      county: d.region || '',
      country: d.country_name || '',
      countryCode: d.country_code || '',
      state: d.region || '',
    },
  };
}

function normalizeIpApiCom(d) {
  if (!d || d.status !== 'success' || !d.query) return null;
  return {
    ip: d.query,
    location: {
      latitude: d.lat,
      longitude: d.lon,
      city: d.city || '',
      county: d.regionName || '',
      country: d.country || '',
      countryCode: d.countryCode || '',
      state: d.regionName || '',
    },
  };
}

// ip-api.com is listed first because it stays reachable through residential /
// mobile proxies where the HTTPS providers below tend to get blocked or
// rate-limited; on a successful hit the others are never tried.
const PROVIDERS = [
  { name: 'ip-api.com', url: 'http://ip-api.com/json/?fields=status,message,query,lat,lon,city,regionName,country,countryCode', parse: normalizeIpApiCom },
  { name: 'ipwho.is', url: 'https://ipwho.is/', parse: normalizeIpwho },
  { name: 'ipapi.co', url: 'https://ipapi.co/json/', parse: normalizeIpapiCo },
];

async function lookup(session, locationConfig = {}, onWarn) {
  const fallback = locationConfig.fallback || {};
  const fallbackResult = {
    ip: fallback.ip || null,
    location: {
      latitude: fallback.latitude ?? null,
      longitude: fallback.longitude ?? null,
      city: fallback.city || '',
      county: fallback.county || '',
      country: fallback.country || '',
      countryCode: fallback.countryCode || '',
      state: fallback.state || '',
    },
    source: 'fallback',
  };

  if (locationConfig.auto_detect === false) return fallbackResult;

  for (const provider of PROVIDERS) {
    try {
      const data = await session.getJson(provider.url);
      const result = provider.parse(data);
      if (result) return { ...result, source: provider.name };
      if (onWarn) onWarn(`geo ${provider.name}: ${data?.reason || data?.message || 'unusable response'}`);
    } catch (err) {
      if (onWarn) onWarn(`geo ${provider.name}: ${err.message}`);
    }
  }

  if (onWarn) onWarn('geo lookup failed on all providers – using fallback location');
  return fallbackResult;
}

module.exports = { lookup };
