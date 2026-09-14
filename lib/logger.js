const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.cwd(), 'logs');
const runTs = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const LOG_FILE = path.join(LOG_DIR, `run_${runTs}.log`);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function write(level, msg) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `[${ts}] [${level.padEnd(7)}] ${msg}`;
  console.log(line);
  stream.write(line + '\n');
}

module.exports = {
  info:    (msg) => write('INFO',    msg),
  success: (msg) => write('SUCCESS', msg),
  warn:    (msg) => write('WARN',    msg),
  error:   (msg) => write('ERROR',   msg),
  file:    LOG_FILE,
};
