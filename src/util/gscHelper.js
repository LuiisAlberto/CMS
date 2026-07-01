const { google } = require('googleapis');
const path = require('path');

let _auth = null;
let _searchconsole = null;

function getSearchConsole() {
  if (_searchconsole) return _searchconsole;
  const keyPath = process.env.GSC_KEY_PATH;
  if (!keyPath || typeof keyPath !== 'string') {
    return null;
  }
  _auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../../', keyPath),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  _searchconsole = google.searchconsole({ version: 'v1', auth: _auth });
  return _searchconsole;
}

/**
 * Obtiene rango de fechas para GSC (datos con 2 días de retraso).
 * @param {number} days - Número de días hacia atrás desde endDate
 * @returns {{ startDate: string, endDate: string }} YYYY-MM-DD
 */
function getDateRange(days = 28) {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() - 2);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(0, days - 1));
  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}

/**
 * Consulta Search Analytics de Google Search Console.
 * @param {Object} opts
 * @param {string} [opts.siteUrl] - URL del sitio en GSC (ej. https://morena.org/). Default: process.env.GSC_SITE_URL
 * @param {number} [opts.days=28] - Días hacia atrás (endDate = hoy - 2)
 * @param {string[]} [opts.dimensions=['date','page','query']] - Dimensiones (date, page, query, country, device, etc.)
 * @param {number} [opts.rowLimit=25000] - Límite de filas (máx 25000)
 * @param {number} [opts.startRow=0] - Offset para paginación
 * @returns {Promise<Array<{ keys: string[], clicks: number, impressions: number, ctr: number, position: number }>>}
 */
async function fetchSearchAnalytics(opts = {}) {
  const searchconsole = getSearchConsole();
  if (!searchconsole) return [];

  const siteUrl = opts.siteUrl || process.env.GSC_SITE_URL;
  const days = opts.days ?? 28;
  const dimensions = opts.dimensions || ['date', 'page', 'query'];
  const rowLimit = Math.min(opts.rowLimit ?? 25000, 25000);
  const startRow = opts.startRow ?? 0;

  const { startDate, endDate } = getDateRange(days);

  const requestBody = {
    startDate,
    endDate,
    dimensions,
    rowLimit,
    startRow,
  };

  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody,
  });

  return res.data.rows || [];
}

/**
 * Versión legacy: fetch por defecto (query+page, 30 días, 10 filas).
 * @param {number} [days=30]
 * @returns {Promise<Array>}
 */
async function fetchMetrics(days = 30) {
  const searchconsole = getSearchConsole();
  if (!searchconsole) return [];

  const { startDate, endDate } = getDateRange(days);
  const res = await searchconsole.searchanalytics.query({
    siteUrl: process.env.GSC_SITE_URL,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query', 'page'],
      rowLimit: 10,
    },
  });
  return res.data.rows || [];
}

module.exports = {
  fetchMetrics,
  fetchSearchAnalytics,
  getDateRange,
};
