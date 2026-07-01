/**
 * Prueba rápida de conexión a Google Search Console.
 * Ejecutar: cd app && node src/util/test-gsc.js
 *
 * Prueba varias variantes de siteUrl y muestra cuál responde OK (si alguna).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const CANDIDATES = [
  'https://morena.org/',
  'https://morena.org',
  'https://www.morena.org/',
  'https://www.morena.org',
  'sc-domain:morena.org',
];

function log(msg) {
  console.log('[test-gsc]', msg);
}

async function tryUrl(siteUrl, fetchSearchAnalytics, getDateRange) {
  const { startDate, endDate } = getDateRange(7);
  const rows = await fetchSearchAnalytics({
    siteUrl,
    days: 7,
    dimensions: ['date', 'page', 'query'],
    rowLimit: 5,
  });
  return { ok: true, rows, startDate, endDate };
}

async function run() {
  log('--- Config ---');
  log('GSC_KEY_PATH: ' + (process.env.GSC_KEY_PATH || '(no definido)'));
  log('GSC_SITE_URL: ' + (process.env.GSC_SITE_URL || '(no definido)'));
  log('Scope:        https://www.googleapis.com/auth/webmasters.readonly');
  log('Service account: revisa client_email en el JSON (debe estar en GSC)');
  log('');

  if (!process.env.GSC_KEY_PATH) {
    log('ERROR: Define GSC_KEY_PATH en .env');
    process.exit(1);
  }

  const { fetchSearchAnalytics, getDateRange } = require('./gscHelper');

  const toTry = process.env.GSC_SITE_URL
    ? [process.env.GSC_SITE_URL.trim(), ...CANDIDATES.filter((c) => c !== process.env.GSC_SITE_URL.trim())]
    : CANDIDATES;
  const seen = new Set();
  const unique = toTry.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  log('Probando variantes de siteUrl (la que coincida con tu propiedad en GSC responderá OK):');
  log('');

  for (const siteUrl of unique) {
    process.stdout.write('  "' + siteUrl + '" ... ');
    try {
      const out = await tryUrl(siteUrl, fetchSearchAnalytics, getDateRange);
      log('OK');
      log('');
      log('>>> Éxito con: "' + siteUrl + '"');
      log('>>> Pon en .env: GSC_SITE_URL=' + siteUrl);
      log('Filas en rango: ' + (out.rows ? out.rows.length : 0));
      if (out.rows && out.rows.length) {
        const r = out.rows[0];
        log('Muestra: keys=' + JSON.stringify(r.keys) + ', clicks=' + r.clicks + ', impressions=' + r.impressions);
      }
      process.exit(0);
    } catch (e) {
      const is403 = (e.code === 403 || (e.cause && e.cause.code === 403));
      log(is403 ? '403 (sin acceso)' : 'Error');
    }
  }

  log('');
  log('Ninguna variante respondió OK.');
  log('Revisa en Search Console:');
  log('  1. Qué propiedad tiene agregado el service account (client_email del JSON).');
  log('  2. El formato exacto de esa propiedad (URL con/sin /, www, o Dominio sc-domain:).');
  log('  3. Permiso al menos "Restringido".');
  process.exit(1);
}

run();
