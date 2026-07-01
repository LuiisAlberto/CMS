const { Op } = require('sequelize');
const { QueryTypes } = require('sequelize');
const dbConection = require('../config/postgresMain');
const { getDateRange } = require('../util/gscHelper');
const { resolveMetricsSyncTargets } = require('../jobs/syncGscMetrics');

/**
 * IDs de instancias a las que el usuario tiene acceso (desde req.usdata.modulos).
 * @param {Object} usdata
 * @returns {number[]}
 */
function allowedInstanceIds(usdata) {
  if (!usdata || !usdata.modulos) return [];
  return Object.keys(usdata.modulos).map((k) => parseInt(k, 10)).filter((n) => !isNaN(n));
}

/**
 * Vista del módulo de métricas (estilo Search Console).
 * Solo instancias a las que el usuario tiene acceso.
 */
async function metricsView(req, res) {
  try {
    const ids = allowedInstanceIds(req.usdata);
    const instances = ids.length
      ? Object.entries(req.usdata.modulos).map(([id, app]) => ({
          id_sysapp: parseInt(id, 10),
          app_name: app.app_name || app.legend,
          appcypher: app.appcypher,
        }))
      : [];

    res.render('../views/metrics', {
      ...req.usdata,
      instances,
      defaultDateRange: 28,
      pageMetrics: true,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Error al cargar métricas' });
  }
}

/**
 * API: overview + queries + pages.
 * Query: dateFrom, dateTo (YYYY-MM-DD), id_sysapp (opcional).
 * Solo instancias permitidas para el usuario.
 */
async function getMetricsData(req, res) {
  try {
    const ids = allowedInstanceIds(req.usdata);
    if (!ids.length) {
      return res.json({
        overview: { clicks: 0, impressions: 0, ctr: 0, position: null },
        byDate: [],
        queries: [],
        pages: [],
      });
    }

    let dateFrom = req.query.dateFrom;
    let dateTo = req.query.dateTo;
    const rawId = req.query.id_sysapp;

    const { startDate: defaultStart, endDate: defaultEnd } = getDateRange(28);
    if (!dateFrom) dateFrom = defaultStart;
    if (!dateTo) dateTo = defaultEnd;

    const instanceFilter = rawId && ids.includes(parseInt(rawId, 10))
      ? [parseInt(rawId, 10)]
      : ids;

    const placeholders = instanceFilter.map((_, i) => `$${i + 1}`).join(', ');
    const bindBase = [...instanceFilter, dateFrom, dateTo];
    const n = instanceFilter.length;
    const $dateFrom = n + 1;
    const $dateTo = n + 2;

    const [overviewRows, byDateRows, queryRows, pageRows] = await Promise.all([
      dbConection.query(
        `SELECT
           COALESCE(SUM(clicks), 0) AS "clicks",
           COALESCE(SUM(impressions), 0) AS "impressions",
           COALESCE(AVG(CAST(position AS FLOAT)) FILTER (WHERE position IS NOT NULL), NULL) AS "position"
         FROM search_metric
         WHERE fk_id_sysapp IN (${placeholders}) AND date BETWEEN $${$dateFrom} AND $${$dateTo}`,
        { type: QueryTypes.SELECT, bind: bindBase }
      ),
      dbConection.query(
        `SELECT date, SUM(clicks) AS "clicks", SUM(impressions) AS "impressions"
         FROM search_metric
         WHERE fk_id_sysapp IN (${placeholders}) AND date BETWEEN $${$dateFrom} AND $${$dateTo}
         GROUP BY date ORDER BY date`,
        { type: QueryTypes.SELECT, bind: bindBase }
      ),
      dbConection.query(
        `SELECT "query",
                SUM(clicks) AS "clicks",
                SUM(impressions) AS "impressions",
                AVG(CAST(position AS FLOAT)) FILTER (WHERE position IS NOT NULL) AS "position"
         FROM search_metric
         WHERE fk_id_sysapp IN (${placeholders}) AND date BETWEEN $${$dateFrom} AND $${$dateTo}
           AND "query" IS NOT NULL AND "query" <> ''
         GROUP BY "query"
         ORDER BY SUM(clicks) DESC NULLS LAST
         LIMIT 500`,
        { type: QueryTypes.SELECT, bind: bindBase }
      ),
      dbConection.query(
        `SELECT page,
                SUM(clicks) AS "clicks",
                SUM(impressions) AS "impressions",
                AVG(CAST(position AS FLOAT)) FILTER (WHERE position IS NOT NULL) AS "position"
         FROM search_metric
         WHERE fk_id_sysapp IN (${placeholders}) AND date BETWEEN $${$dateFrom} AND $${$dateTo}
           AND page IS NOT NULL AND page <> ''
         GROUP BY page
         ORDER BY SUM(clicks) DESC NULLS LAST
         LIMIT 500`,
        { type: QueryTypes.SELECT, bind: bindBase }
      ),
    ]);

    const ov = overviewRows[0] || {};
    const totalClicks = Number(ov.clicks) || 0;
    const totalImpressions = Number(ov.impressions) || 0;
    const ctr = totalImpressions ? (totalClicks / totalImpressions) : 0;
    const position = ov.position != null ? parseFloat(ov.position) : null;

    res.json({
      overview: {
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: Math.round(ctr * 10000) / 100,
        position: position != null ? Math.round(position * 100) / 100 : null,
      },
      byDate: (byDateRows || []).map((r) => ({
        date: r.date,
        clicks: Number(r.clicks) || 0,
        impressions: Number(r.impressions) || 0,
      })),
      queries: (queryRows || []).map((r) => ({
        query: r.query,
        clicks: Number(r.clicks) || 0,
        impressions: Number(r.impressions) || 0,
        position: r.position != null ? Math.round(parseFloat(r.position) * 100) / 100 : null,
      })),
      pages: (pageRows || []).map((r) => ({
        page: r.page,
        clicks: Number(r.clicks) || 0,
        impressions: Number(r.impressions) || 0,
        position: r.position != null ? Math.round(parseFloat(r.position) * 100) / 100 : null,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Error al obtener métricas' });
  }
}

/**
 * Diagnóstico: instancias del usuario, instancia de sync, y si hay datos.
 * GET /api/metrics/status
 */
async function getMetricsStatus(req, res) {
  try {
    const ids = allowedInstanceIds(req.usdata);
    const allTargets = await resolveMetricsSyncTargets();
    const visibleTargets = (allTargets || []).filter((t) => ids.includes(t.id_sysapp));
    const { startDate, endDate } = getDateRange(28);

    let rowCount = 0;
    if (ids.length) {
      try {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        const bind = [...ids, startDate, endDate];
        const n = ids.length;
        const rows = await dbConection.query(
          `SELECT COUNT(*) AS c FROM search_metric
           WHERE fk_id_sysapp IN (${placeholders}) AND date BETWEEN $${n + 1} AND $${n + 2}`,
          { type: QueryTypes.SELECT, bind }
        );
        const r = rows && rows[0];
        rowCount = r && r.c != null ? parseInt(String(r.c), 10) : 0;
      } catch (_) {
        rowCount = 0;
      }
    }

    let message = '';
    if (!ids.length) message = 'Tu usuario no tiene acceso a ninguna instancia (revisa permisos).';
    else if (!visibleTargets.length) message = 'No hay dominios publicados/indexables en tus instancias (publicada + urluri).';
    else if (rowCount === 0) message = 'Aún no hay datos. Ejecuta: cd app && npm run sync-metrics';
    else message = 'OK';

    res.json({
      userInstanceIds: ids,
      targetInstanceIds: visibleTargets.map((t) => t.id_sysapp),
      targetCount: visibleTargets.length,
      rowCount,
      dateRange: { startDate, endDate },
      message,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Error en diagnóstico', error: e.message });
  }
}

module.exports = {
  metricsView,
  getMetricsData,
  getMetricsStatus,
};
