const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const RESULTS_FILE = path.join(ROOT, 'results.csv');

// Sentinel lines in proxies.txt that mean "use the local/direct connection".
const DIRECT_PROXY = new Set(['localhost', 'local', 'direct', 'none', 'no-proxy']);

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

function loadProxies() {
  const file = path.join(ROOT, 'proxies.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      if (DIRECT_PROXY.has(line.toLowerCase())) return null;
      const parts = line.split(':');
      return { host: parts[0], port: parts[1], user: parts[2] || '', pass: parts[3] || '' };
    });
}

function loadTasks(onWarn = () => {}) {
  const rows = parse(fs.readFileSync(path.join(ROOT, 'input.csv'), 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true,
  });
  return rows.filter(row => {
    if (!row['Email']) {
      onWarn('Skipping row – missing Email');
      return false;
    }
    return true;
  });
}

// Addresses already registered in an earlier run, so a restart resumes.
function loadCompleted(onWarn = () => {}) {
  const done = new Set();
  if (!fs.existsSync(RESULTS_FILE)) return done;
  try {
    const rows = parse(fs.readFileSync(RESULTS_FILE, 'utf8'), {
      columns: true, skip_empty_lines: true, trim: true, relax_quotes: true,
    });
    for (const r of rows) {
      if ((r.status || '').toLowerCase() === 'success') done.add((r.email || '').toLowerCase());
    }
  } catch (err) {
    onWarn(`Could not read ${path.basename(RESULTS_FILE)}: ${err.message}`);
  }
  return done;
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordResult(email, status, detail = '') {
  if (!fs.existsSync(RESULTS_FILE)) fs.writeFileSync(RESULTS_FILE, 'timestamp,email,status,detail\n');
  const fields = [new Date().toISOString(), email, status, String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300)];
  fs.appendFileSync(RESULTS_FILE, fields.map(csvField).join(',') + '\n');
}

function imapOverrides(row) {
  return {
    host: row['Imap Host'] || '',
    port: row['Imap Port'] ? Number(row['Imap Port']) : 0,
    user: row['Imap User'] || '',
    password: row['Imap Password'] || '',
  };
}

function profileFromRow(row) {
  return {
    firstName: row['FirstName'] || '',
    lastName: row['LastName'] || '',
    dateOfBirth: row['DateOfBirth'] || '',
    countryCallingCode: String(row['CountryCallingCode'] || ''),
    nationalPhoneNumber: String(row['PhoneNumber'] || ''),
    city: row['City'] || row['Location'] || '',
  };
}

module.exports = {
  RESULTS_FILE, loadConfig, loadProxies, loadTasks,
  loadCompleted, recordResult, imapOverrides, profileFromRow,
};
