/**
 * Job de sincronización: Google Search Console → search_metric (BD).
 * Ejecutar 1 vez al día (p. ej. vía node-cron a las 03:00).
 * Los datos se consumen desde el módulo de métricas sin llamar a GSC.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { QueryTypes } = require('sequelize');
const dbConection = require('../config/postgresMain');
const { fetchSearchAnalytics, getDateRange } = require('../util/gscHelper');
const SearchMetric = require('../models/SearchMetric');

const GSC_ROW_LIMIT = 25000;
const GSC_DAYS = 28;
const BATCH_SIZE = 500;

function normalizeGscSiteUrl(urluri) {
  const raw = String(urluri || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, '') + '/';
}

/**
 * Instancias candidatas para sincronizar métricas por dominio publicado.
 * Reglas:
 * - tipo 2/3
 * - vigente y publicada
 * - urluri (dominio) configurado
 */
async function resolveMetricsSyncTargets() {
  const group = process.env.GRUPO_APLICACIONES;
  if (!group) return [];

  const rows = await dbConection.query(
    `SELECT s.id_sysapp, s.urluri, s.sysapp_name, s.app_legend
     FROM sysapp s
     JOIN rel_sysapp_group r ON r.fk_id_sysapp = s.id_sysapp AND r.fk_id_sysapp_group = $1
     WHERE s.fk_id_sysapp_type IN (2, 3)
       AND s.vigente = true
       AND s.publicada = true
       AND s.urluri IS NOT NULL
       AND TRIM(s.urluri) <> ''
     ORDER BY s.fk_id_sysapp_type ASC, s.id_sysapp ASC`,
    { type: QueryTypes.SELECT, bind: [group] }
  );

  return (rows || []).map((r) => ({
    id_sysapp: parseInt(r.id_sysapp, 10),
    siteUrl: normalizeGscSiteUrl(r.urluri),
    name: r.app_legend || r.sysapp_name || `Instancia ${r.id_sysapp}`,
  })).filter((r) => Number.isFinite(r.id_sysapp) && r.siteUrl);
}

function batchUpsert(rows, idApp, now) {
  const valid = rows.filter((r) => r.keys && r.keys[0]);
  if (!valid.length) return Promise.resolve();

  const vals = valid.flatMap((r) => [
    idApp,
    r.keys[0],
    r.keys[1] || null,
    r.keys[2] || null,
    r.clicks ?? 0,
    r.impressions ?? 0,
    r.position != null ? r.position : null,
    r.ctr != null ? r.ctr : null,
    now,
  ]);
  const ph = valid.map((_, i) => {
    const j = i * 9;
    return `($${j + 1}, $${j + 2}, $${j + 3}, $${j + 4}, $${j + 5}, $${j + 6}, $${j + 7}, $${j + 8}, $${j + 9})`;
  }).join(', ');
  const sql = `
    INSERT INTO search_metric (fk_id_sysapp, date, page, "query", clicks, impressions, position, ctr, f_sync)
    VALUES ${ph}
    ON CONFLICT (fk_id_sysapp, date, page, "query")
    DO UPDATE SET
      clicks = EXCLUDED.clicks,
      impressions = EXCLUDED.impressions,
      position = EXCLUDED.position,
      ctr = EXCLUDED.ctr,
      f_sync = EXCLUDED.f_sync
  `;
  return dbConection.query(sql, { bind: vals, type: QueryTypes.UPDATE });
}

/**
 * Sincroniza métricas GSC por cada dominio publicado y las persiste en search_metric.
 */
async function runSync() {
  const log = (msg) => console.log(`[syncGscMetrics] ${new Date().toISOString()} ${msg}`);

  try {
    await SearchMetric.sync();

    const targets = await resolveMetricsSyncTargets();
    if (!targets.length) {
      log('No hay instancias publicadas con dominio para sync de métricas. Aborto.');
      return { ok: false, reason: 'no_targets' };
    }

    const { startDate, endDate } = getDateRange(GSC_DAYS);
    const now = new Date();
    let processed = 0;
    let syncedInstances = 0;

    for (const target of targets) {
      log(`Fetch GSC ${target.siteUrl} [${startDate} .. ${endDate}] → fk_id_sysapp=${target.id_sysapp}`);
      let rows = [];
      try {
        rows = await fetchSearchAnalytics({
          siteUrl: target.siteUrl,
          days: GSC_DAYS,
          dimensions: ['date', 'page', 'query'],
          rowLimit: GSC_ROW_LIMIT,
        });
      } catch (err) {
        // Si una propiedad no existe/no tiene acceso en GSC, no detener el sync de las demás instancias.
        log(`No se pudo consultar ${target.siteUrl} (${target.name}): ${err.message}`);
        continue;
      }

      if (!rows.length) {
        log(`Sin filas de GSC para ${target.siteUrl}.`);
        syncedInstances += 1;
        continue;
      }

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await batchUpsert(batch, target.id_sysapp, now);
        processed += batch.length;
      }
      syncedInstances += 1;
    }

    log(`Listo: ${processed} filas procesadas en ${syncedInstances}/${targets.length} instancias objetivo.`);
    return { ok: true, total: processed, syncedInstances, totalTargets: targets.length };
  } catch (err) {
    log(`Error: ${err.message}`);
    console.error(err);
    return { ok: false, error: err.message };
  }
}

/**
 * Ejecuta el job (para uso desde cron o CLI).
 * Uso CLI: `node src/jobs/syncGscMetrics.js`
 */
async function main() {
  const result = await runSync();
  if (process.argv[1] && process.argv[1].includes('syncGscMetrics')) {
    process.exit(result.ok ? 0 : 1);
  }
  return result;
}

module.exports = { runSync, resolveMetricsSyncTargets };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
