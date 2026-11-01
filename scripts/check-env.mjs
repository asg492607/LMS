import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

const root = process.cwd();
const apiEnvPath = resolve(root, '.env');
const browserEnvPath = resolve(root, '.env.local');
const ignorePath = resolve(root, '.gitignore');
const caPath = resolve(root, 'server/certs/supabase-root-ca.crt');
const issues = [];
const results = [];

function report(label, ok) {
  results.push({ label, ok });
  if (!ok) issues.push(label);
}

function parseEnv(path) {
  if (!existsSync(path)) return null;
  return dotenv.parse(readFileSync(path));
}

function duplicates(path) {
  if (!existsSync(path)) return [];
  const found = new Set();
  const repeated = new Set();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) continue;
    if (found.has(match[1])) repeated.add(match[1]);
    found.add(match[1]);
  }
  return [...repeated];
}

const api = parseEnv(apiEnvPath);
const browser = parseEnv(browserEnvPath);
report('API .env exists', api !== null);
report('Browser .env.local exists', browser !== null);

if (api && browser) {
  const requiredApi = [
    'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_DB_HOST',
    'SUPABASE_DB_PORT', 'SUPABASE_DB_NAME', 'SUPABASE_DB_USER', 'SUPABASE_DB_PASSWORD',
  ];
  report('API settings are populated', requiredApi.every((key) => Boolean(api[key]?.trim())));
  report('Auth Admin secret is configured', Boolean((api.SUPABASE_SECRET_KEY || api.SUPABASE_SERVICE_ROLE_KEY)?.trim()));
  const authAdminKey = api.SUPABASE_SECRET_KEY || api.SUPABASE_SERVICE_ROLE_KEY || '';
  report('Server credentials meet minimum length', authAdminKey.length >= 40 && (api.SUPABASE_DB_PASSWORD?.length || 0) >= 24);
  report('Browser settings are populated', Boolean(browser.VITE_SUPABASE_URL?.trim() && browser.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()));

  const browserSecretNames = Object.keys(browser).filter((key) => /SECRET|SERVICE_ROLE|DB_PASSWORD|PRIVATE_KEY/i.test(key));
  report('No server secrets are in .env.local', browserSecretNames.length === 0);
  report('No VITE_ settings are in the API .env', !Object.keys(api).some((key) => key.startsWith('VITE_')));
  report('No duplicate variable names', duplicates(apiEnvPath).length === 0 && duplicates(browserEnvPath).length === 0);

  let apiUrl;
  let browserUrl;
  try {
    apiUrl = new URL(api.SUPABASE_URL);
    browserUrl = new URL(browser.VITE_SUPABASE_URL);
  } catch {
    // Invalid URL is reported by the following URL checks.
  }
  report('Supabase URLs use HTTPS', Boolean(apiUrl && browserUrl && apiUrl.protocol === 'https:' && browserUrl.protocol === 'https:'));
  report('API and browser Supabase URLs match', Boolean(apiUrl && browserUrl && apiUrl.origin === browserUrl.origin));
  report('Publishable keys match and have the expected prefix', Boolean(
    api.SUPABASE_PUBLISHABLE_KEY
    && api.SUPABASE_PUBLISHABLE_KEY === browser.VITE_SUPABASE_PUBLISHABLE_KEY
    && api.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_'),
  ));
  report('Auth Admin key has the expected server key prefix', Boolean(
    api.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')
    || api.SUPABASE_SERVICE_ROLE_KEY?.startsWith('eyJ'),
  ));
  const liveValues = [...Object.values(api), ...Object.values(browser)];
  report('No setup placeholders remain in local env files', liveValues.every((value) => !/(your-project-ref|replace[_ -]?me|replace_with|placeholder)/i.test(value)));
  report('Postgres uses the restricted LMS role', api.SUPABASE_DB_USER === 'lms_backend');

  const projectRef = apiUrl?.hostname.split('.')[0];
  const expectedDbHost = projectRef ? `db.${projectRef}.supabase.co` : '';
  report('Database host belongs to the configured project', Boolean(
    api.SUPABASE_DB_HOST
    && (api.SUPABASE_DB_HOST === expectedDbHost
      || /^[a-z0-9.-]+\.pooler\.supabase\.(com|net)$/i.test(api.SUPABASE_DB_HOST)),
  ));
  report('Database port is valid', Number.isInteger(Number(api.SUPABASE_DB_PORT)) && Number(api.SUPABASE_DB_PORT) > 0 && Number(api.SUPABASE_DB_PORT) <= 65535);
  report('Postgres TLS root certificate exists', existsSync(caPath));
}

let ignoreText = '';
if (existsSync(ignorePath)) ignoreText = readFileSync(ignorePath, 'utf8');
report('.env files are covered by .gitignore', /^\.env\s*$/m.test(ignoreText) && /^\.env\.\*\s*$/m.test(ignoreText));
report('Safe env examples are allowed by .gitignore', /^!\.env\.example\s*$/m.test(ignoreText) && /^!\.env\.local\.example\s*$/m.test(ignoreText));

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.label}`);
if (issues.length) {
  console.error(`Environment configuration needs attention (${issues.length} item(s)). Values were not displayed.`);
  process.exitCode = 1;
} else {
  console.log('Environment configuration is consistent. Credential values were not displayed.');
}
