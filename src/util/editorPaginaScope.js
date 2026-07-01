/**
 * Alcance de páginas para editores (tipo 13) por instancia.
 * Tabla wb_user_editor_pagina_scope en PGDB_NAME (ej. group_website_mrn).
 * fk_id_wb_pagina NULL = todas las páginas de ese tipo; varias filas = solo esas páginas (whitelist).
 */
const dbWebsite = require('../config/postgressdb');
const { QueryTypes } = require('sequelize');

const TIPO_PRINCIPAL = 1;
const TIPO_INTERIOR = 2;
const TIPO_ENTRADA = 5;
/** Sección “Regeneración” (documentos con tag 13); no es fila en wb_pagina — alcance solo “todas” (NULL fk_id_wb_pagina). */
const TIPO_REGENERACION = 6;

/**
 * @returns {Promise<Record<number, { all: boolean, pageIds?: number[], pageId?: number }>|null>}
 *   null = sin reglas (acceso completo a tipos de página como antes).
 */
async function getEditorPaginaScopeDetail(idUser, idSysapp) {
  const uid = parseInt(idUser, 10);
  const aid = parseInt(idSysapp, 10);
  if (!Number.isFinite(uid) || !Number.isFinite(aid)) return null;

  try {
    const rows = await dbWebsite.query(
      `SELECT fk_id_cat_type_pagina, fk_id_wb_pagina
       FROM wb_user_editor_pagina_scope
       WHERE fk_id_user = $1::integer
         AND fk_id_sysapp = $2::integer
         AND (vigente IS NOT FALSE)
       ORDER BY fk_id_cat_type_pagina`,
      { bind: [uid, aid], type: QueryTypes.SELECT }
    );
    if (!rows || rows.length === 0) return null;
    const byTipo = new Map();
    for (const r of rows) {
      const t = parseInt(r.fk_id_cat_type_pagina, 10);
      if (!Number.isFinite(t)) continue;
      if (!byTipo.has(t)) byTipo.set(t, { hasNull: false, ids: new Set() });
      const g = byTipo.get(t);
      const pidRaw = r.fk_id_wb_pagina;
      if (pidRaw == null || pidRaw === '') {
        g.hasNull = true;
      } else {
        const pid = parseInt(pidRaw, 10);
        if (Number.isFinite(pid)) g.ids.add(pid);
      }
    }
    const out = {};
    for (const [t, g] of byTipo) {
      if (g.hasNull) {
        out[t] = { all: true };
      } else {
        const arr = [...g.ids].filter((n) => Number.isFinite(n));
        out[t] = { all: false, pageIds: arr };
      }
    }
    return out;
  } catch (e) {
    console.warn('[getEditorPaginaScopeDetail]', e.message);
    return null;
  }
}

/** @returns {Promise<number[]|null>} tipos permitidos (1,2,5) o null si no hay reglas */
async function getAllowedPaginaTiposForEditor(idUser, idSysapp) {
  const d = await getEditorPaginaScopeDetail(idUser, idSysapp);
  if (d == null) return null;
  return Object.keys(d)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * @param {Record<number, { all: boolean, pageIds?: number[], pageId?: number }>|null} detail
 * @param {number|string} idPagina
 * @param {number|string} fkTipoPagina
 * @returns {boolean} true = denegado
 */
function isPaginaDeniedByScopeDetail(detail, idPagina, fkTipoPagina) {
  if (detail == null) return false;
  const t = Number(fkTipoPagina);
  const rule = detail[t];
  if (!rule) return true;
  if (rule.all) return false;
  const id = Number(idPagina);
  if (Array.isArray(rule.pageIds) && rule.pageIds.length) {
    const set = new Set(rule.pageIds.map((x) => Number(x)));
    return !set.has(id);
  }
  if (rule.pageId != null && rule.pageId !== '') {
    return Number(rule.pageId) !== id;
  }
  return true;
}

/**
 * @param {{ fk_id_cat_type_users?: number }} usdataOrUser
 * @returns {Promise<boolean>} true = denegado (solo por tipo, sin id de página)
 */
async function isPaginaTipoDeniedForEditor(usdataOrUser, idSysapp, fkTipoPagina) {
  const tipoUser = Number(usdataOrUser?.fk_id_cat_type_users);
  if (tipoUser !== 13) return false;

  const uid = parseInt(usdataOrUser?.id_user, 10);
  if (!Number.isFinite(uid)) return false;
  const detail = await getEditorPaginaScopeDetail(uid, idSysapp);
  if (detail == null) return false;

  const t = Number(fkTipoPagina);
  const rule = detail[t];
  if (!rule) return true;
  if (t === TIPO_ENTRADA || t === TIPO_REGENERACION) {
    return rule.all !== true;
  }
  return false;
}

module.exports = {
  TIPO_PRINCIPAL,
  TIPO_INTERIOR,
  TIPO_ENTRADA,
  TIPO_REGENERACION,
  getEditorPaginaScopeDetail,
  getAllowedPaginaTiposForEditor,
  isPaginaTipoDeniedForEditor,
  isPaginaDeniedByScopeDetail,
};
