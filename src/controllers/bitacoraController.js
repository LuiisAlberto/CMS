const { QueryTypes } = require('sequelize');
const dbConection = require('../config/postgressdb');
const auth = require('../middleware/auth');

function allowedInstanceIds(usdata) {
  if (!usdata || !usdata.modulos) return [];
  return Object.keys(usdata.modulos)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n));
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function normalizeTypeUser(value) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeInstance(value, allowedIds) {
  const n = parseInt(String(value || ''), 10);
  if (!Number.isFinite(n)) return null;
  if (allowedIds == null || !Array.isArray(allowedIds)) return n;
  return allowedIds.includes(n) ? n : null;
}

/** Texto legible para la columna IP (evita que ::1 parezca “vacío”). */
function formatBitacoraIpDisplay(ip) {
  if (ip == null || String(ip).trim() === '') return '—';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') return '127.0.0.1 (equipo local)';
  if (s === '127.0.0.1') return '127.0.0.1 (equipo local)';
  return s;
}

async function bitacoraView(req, res) {
  try {
    const instanceIds = allowedInstanceIds(req.usdata);
    /**
     * Quien puede abrir este submódulo debe ver el historial completo del CMS (audit),
     * no solo filas de las instancias que aparecen en su menú lateral.
     * Incluye /admin/bitacora además de /users por si el rol no tiene el archivo de usuarios.
     */
    const verTodoElCms =
      auth.hasArchivoAccess(req, '/users') ||
      auth.hasArchivoAccess(req, '/admin/bitacora');
    const instances = Object.entries(req.usdata?.modulos || {}).map(([id, app]) => ({
      id_sysapp: parseInt(id, 10),
      app_name: app.app_name || app.legend || `Instancia ${id}`,
    }));

    const qFechaInicio = normalizeDate(req.query.fecha_inicio);
    const qFechaFin = normalizeDate(req.query.fecha_fin);
    const qTipoUsuario = normalizeTypeUser(req.query.tipo_usuario);
    const qInstanciaEfectiva = normalizeInstance(
      req.query.id_sysapp,
      verTodoElCms ? null : instanceIds
    );
    const qBuscar = String(req.query.buscar || '')
      .trim()
      .slice(0, 200);

    const where = [];
    const bind = [];
    let idx = 1;

    if (!verTodoElCms) {
      if (instanceIds.length) {
        const placeholders = instanceIds.map(() => `$${idx++}`);
        bind.push(...instanceIds);
        where.push(
          `(b.fk_id_sysapp IS NULL OR b.fk_id_sysapp IN (${placeholders.join(',')}))`
        );
      } else {
        where.push('1 = 0');
      }
    }

    if (qInstanciaEfectiva != null) {
      where.push(`b.fk_id_sysapp = $${idx++}`);
      bind.push(qInstanciaEfectiva);
    }
    if (qTipoUsuario != null) {
      where.push(`ua.fk_id_cat_type_users = $${idx++}`);
      bind.push(qTipoUsuario);
    }
    if (qFechaInicio) {
      where.push(`b.f_reg::date >= $${idx++}`);
      bind.push(qFechaInicio);
    }
    if (qFechaFin) {
      where.push(`b.f_reg::date <= $${idx++}`);
      bind.push(qFechaFin);
    }
    if (qBuscar) {
      const iBuscar = idx;
      where.push(`(
        POSITION(LOWER($${iBuscar}::text) IN LOWER(COALESCE(c.clave, '') || ' ' || COALESCE(c.descripcion, ''))) > 0
        OR POSITION(LOWER($${iBuscar}::text) IN LOWER(COALESCE(CONCAT_WS(' ', ua.nombre, ua.primer_apellido, ua.segundo_apellido), ''))) > 0
        OR POSITION(LOWER($${iBuscar}::text) IN LOWER(COALESCE(CONCAT_WS(' ', uf.nombre, uf.primer_apellido, uf.segundo_apellido), ''))) > 0
        OR POSITION(LOWER($${iBuscar}::text) IN LOWER(COALESCE(s.app_legend, ''))) > 0
        OR POSITION(LOWER($${iBuscar}::text) IN LOWER(COALESCE(wp.nombre_pagina, '') || ' ' || COALESCE(wp.url_safe, ''))) > 0
        OR POSITION(LOWER($${iBuscar}::text) IN LOWER(COALESCE(b.detalle::text, ''))) > 0
      )`);
      bind.push(qBuscar);
      idx += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const perPage = 25;
    const pageRaw = parseInt(String(req.query.page || '1'), 10);
    let page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    const fromBitacoraJoins = `
       FROM cms_bitacora b
       LEFT JOIN cat_bitacora_cms c ON c.id_cat_bitacora_cms = b.fk_id_cat_bitacora_cms
       LEFT JOIN users ua ON ua.id_user = b.fk_id_user_actor
       LEFT JOIN users uf ON uf.id_user = b.fk_id_user_afectado
       LEFT JOIN sysapp s ON s.id_sysapp = b.fk_id_sysapp
       LEFT JOIN wb_pagina wp ON wp.id_wb_pagina = b.id_wb_pagina`;

    const countRows = await dbConection.query(
      `SELECT COUNT(*)::int AS n
       ${fromBitacoraJoins}
       ${whereSql}`,
      { type: QueryTypes.SELECT, bind }
    );
    const total = countRows[0]?.n ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (page > totalPages) page = totalPages;
    const offset = (page - 1) * perPage;

    const bindPage = [...bind, perPage, offset];
    const iLim = bind.length + 1;
    const iOff = bind.length + 2;

    const rowsRaw = await dbConection.query(
      `SELECT
          b.id_bitacora,
          b.f_reg,
          b.fk_id_sysapp,
          s.app_legend AS instancia_nombre,
          c.clave AS accion_clave,
          COALESCE(c.descripcion, '(Sin catálogo)') AS accion_descripcion,
          ua.id_user AS actor_id,
          CONCAT_WS(' ', ua.nombre, ua.primer_apellido, ua.segundo_apellido) AS actor_nombre,
          tua.type_user AS actor_tipo_usuario,
          uf.id_user AS afectado_id,
          CONCAT_WS(' ', uf.nombre, uf.primer_apellido, uf.segundo_apellido) AS afectado_nombre,
          b.id_wb_pagina,
          wp.nombre_pagina AS pagina_nombre,
          wp.url_safe AS pagina_url_safe,
          b.ip_origen,
          b.detalle
       ${fromBitacoraJoins}
       LEFT JOIN cat_type_users tua ON tua.id_cat_type_users = ua.fk_id_cat_type_users
       ${whereSql}
       ORDER BY b.f_reg DESC
       LIMIT $${iLim}::integer OFFSET $${iOff}::integer`,
      { type: QueryTypes.SELECT, bind: bindPage }
    );

    const rows = (rowsRaw || []).map((r) => ({
      ...r,
      ip_display: formatBitacoraIpDisplay(r.ip_origen),
    }));

    const tiposUsuario = await dbConection.query(
      `SELECT id_cat_type_users, type_user
       FROM cat_type_users
       WHERE vigente IS TRUE
       ORDER BY id_cat_type_users ASC`,
      { type: QueryTypes.SELECT }
    );

    return res.render('../views/bitacora', {
      ...req.usdata,
      instances,
      tiposUsuario: tiposUsuario || [],
      filtros: {
        fecha_inicio: qFechaInicio || '',
        fecha_fin: qFechaFin || '',
        tipo_usuario: qTipoUsuario != null ? String(qTipoUsuario) : '',
        id_sysapp: qInstanciaEfectiva != null ? String(qInstanciaEfectiva) : '',
        buscar: qBuscar,
      },
      rows: rows || [],
      pagination: {
        page,
        perPage,
        total,
        totalPages,
        from: total === 0 ? 0 : offset + 1,
        to: Math.min(offset + perPage, total),
      },
    });
  } catch (e) {
    console.error('[bitacoraView]', e);
    return res.status(500).json({ success: false, message: 'Error al cargar bitácora' });
  }
}

module.exports = {
  bitacoraView,
};
