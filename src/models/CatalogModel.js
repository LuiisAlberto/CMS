const dbConection = require('../config/postgressdb');
/** BD principal (PGDB_NAME_MAIN). Las tablas cat_roles_sysapp / rel_user_sysapp_roles pueden vivir aquí o en PGDB_NAME según despliegue; getPermisos consulta ambas. */
const dbSysMorena = require('../config/postgresMain');
const { QueryTypes } = require('sequelize');

const SQL_PERMISOS_SYS = `SELECT sysapp.fk_id_sysapp_type AS id_sysapp_type,
                                     sysapp.app_legend,
                                     sysapp.id_sysapp,
                                     m.modulo_legend,
                                     m.micon,
                                     m.id_sysmod,
                                     s.submodulo_legend,
                                     s.id_syssubmod,
                                     r.archivo,
                                     s.submodulo_legend AS legend,
                                     s.smicon,
                                     m.order_mod,
                                     s.order_submod
                              FROM rutas r
                                       INNER JOIN syssubmod s ON s.fk_id_ruta = r.id_ruta
                                       INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                                       LEFT JOIN sysapp_group g ON g.id_sysapp_group = m.fk_id_sysapp_group
                                       INNER JOIN sys_perm ru ON ru.fk_id_syssubmod = s.id_syssubmod
                                         AND ru.fk_id_user = $1
                                         AND (ru.vigente IS NOT FALSE OR ru.vigente IS NULL)
                                       INNER JOIN sysapp ON sysapp.id_sysapp = ru.fk_id_sysapp
                                       INNER JOIN rel_sysapp_group rl ON rl.fk_id_sysapp = sysapp.id_sysapp
                              WHERE rl.fk_id_sysapp_group = $2
                                AND m.fk_id_sysapp_group = $2
                                AND r.vigente IS TRUE
                                AND (s.vigente IS NOT FALSE)
                                AND m.vigente IS TRUE
                                AND g.vigente IS TRUE
                                AND sysapp.vigente IS TRUE`;

const SQL_PERMISOS_ROLES_CMS = `SELECT sysapp.fk_id_sysapp_type AS id_sysapp_type,
                                     sysapp.app_legend,
                                     sysapp.id_sysapp,
                                     m.modulo_legend,
                                     m.micon,
                                     m.id_sysmod,
                                     s.submodulo_legend,
                                     s.id_syssubmod,
                                     r.archivo,
                                     s.submodulo_legend AS legend,
                                     s.smicon,
                                     m.order_mod,
                                     s.order_submod
                              FROM rel_user_sysapp_roles rur
                                       INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
                                         AND (crs.vigente IS NOT FALSE)
                                         AND (rur.vigente IS NOT FALSE)
                                         AND crs.fk_id_sysapp = $3::integer
                                       CROSS JOIN LATERAL unnest(COALESCE(crs.default_sub_modules, ARRAY[]::integer[])) AS u(syssubmod_id)
                                       INNER JOIN syssubmod s ON s.id_syssubmod = u.syssubmod_id
                                       INNER JOIN rutas r ON r.id_ruta = s.fk_id_ruta
                                       INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                                       LEFT JOIN sysapp_group g ON g.id_sysapp_group = m.fk_id_sysapp_group
                                       INNER JOIN sysapp ON sysapp.id_sysapp = crs.fk_id_sysapp
                                       INNER JOIN rel_sysapp_group rl ON rl.fk_id_sysapp = sysapp.id_sysapp
                              WHERE rur.fk_id_user = $1::integer
                                AND rl.fk_id_sysapp_group = $2::integer
                                AND m.fk_id_sysapp_group = $2::integer
                                AND r.vigente IS TRUE
                                AND (s.vigente IS NOT FALSE)
                                AND m.vigente IS TRUE
                                AND g.vigente IS TRUE
                                AND sysapp.vigente IS TRUE`;

function sortPermisosRows(rows) {
  const arr = Array.isArray(rows) ? [...rows] : [];
  arr.sort((a, b) => {
    const ta = parseInt(a.id_sysapp_type, 10) || 0;
    const tb = parseInt(b.id_sysapp_type, 10) || 0;
    if (ta !== tb) return ta - tb;
    const ia = parseInt(a.id_sysapp, 10) || 0;
    const ib = parseInt(b.id_sysapp, 10) || 0;
    if (ia !== ib) return ia - ib;
    const oma = parseInt(a.order_mod, 10) || 0;
    const omb = parseInt(b.order_mod, 10) || 0;
    if (oma !== omb) return oma - omb;
    const osa = parseInt(a.order_submod, 10) || 0;
    const osb = parseInt(b.order_submod, 10) || 0;
    return osa - osb;
  });
  return arr;
}

function mergePermisosDedupe(baseRows, extraRows) {
  const seen = new Set();
  const out = [];
  for (const row of baseRows || []) {
    const k = `${row.id_sysapp}:${row.id_syssubmod}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(row);
    }
  }
  for (const row of extraRows || []) {
    const k = `${row.id_sysapp}:${row.id_syssubmod}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(row);
    }
  }
  return sortPermisosRows(out);
}

/**
 * Permisos por rol CMS desde una conexión. Ignora 42P01 (tablas ausentes en esa BD).
 */
async function queryPermisosRolesCms(conn, uid, gid, cmsApp) {
  try {
    return await conn.query(
      `${SQL_PERMISOS_ROLES_CMS} ORDER BY sysapp.fk_id_sysapp_type, sysapp.id_sysapp, m.order_mod, s.order_submod`,
      {
        type: QueryTypes.SELECT,
        bind: [uid, gid, cmsApp],
      }
    );
  } catch (e) {
    const missing =
      e && ((e.parent && e.parent.code === '42P01') || (e.original && e.original.code === '42P01'));
    if (missing) return [];
    throw e;
  }
}

/**
 * Permisos efectivos del menú: sys_perm ∪ submódulos concedidos vía cat_roles_sysapp + rel_user_sysapp_roles
 * para el sysapp del CMS (CMS_SYSAPP), sin duplicar filas.
 */
async function getPermisos(id_user) {
  const logPerm = process.env.LOG_PERMISOS === '1' || process.env.LOG_PERMISOS === 'true';
  const uid = parseInt(id_user, 10);
  const gid = parseInt(process.env.GRUPO_APLICACIONES, 10);
  const cmsApp = parseInt(process.env.CMS_SYSAPP, 10);

  if (logPerm) {
    console.log('[getPermisos] usuario', id_user, 'GRUPO_APLICACIONES', process.env.GRUPO_APLICACIONES, 'CMS_SYSAPP', process.env.CMS_SYSAPP);
  }

  const rowsSys = Number.isFinite(uid) && Number.isFinite(gid)
    ? await dbConection.query(`${SQL_PERMISOS_SYS} ORDER BY sysapp.fk_id_sysapp_type, sysapp.id_sysapp, m.order_mod, s.order_submod`, {
        type: QueryTypes.SELECT,
        bind: [uid, gid],
      })
    : [];

  let merged = Array.isArray(rowsSys) ? rowsSys : [];

  if (Number.isFinite(uid) && Number.isFinite(gid) && Number.isFinite(cmsApp)) {
    const rowsRoleMain = await queryPermisosRolesCms(dbSysMorena, uid, gid, cmsApp);
    const rowsRoleCatalog = await queryPermisosRolesCms(dbConection, uid, gid, cmsApp);
    const rowsRole = mergePermisosDedupe(rowsRoleMain || [], rowsRoleCatalog || []);
    if (
      logPerm &&
      (!rowsRoleMain || rowsRoleMain.length === 0) &&
      (!rowsRoleCatalog || rowsRoleCatalog.length === 0)
    ) {
      const mismoDb = String(process.env.PGDB_NAME || '') === String(process.env.PGDB_NAME_MAIN || '');
      if (!mismoDb) {
        console.warn(
          '[getPermisos] roles CMS: sin filas en postgresMain ni en postgressdb; revisa rel_user_sysapp_roles / cat_roles_sysapp y que CMS_SYSAPP coincida.'
        );
      }
    }
    merged = mergePermisosDedupe(merged, rowsRole);
  } else {
    merged = sortPermisosRows(merged);
  }

  if (logPerm) {
    const resumen = (merged || []).map((r) => ({
      id_sysapp: r.id_sysapp,
      archivo: r.archivo,
      legend: r.legend || r.submodulo_legend,
    }));
    console.log('[getPermisos] filas', resumen.length, resumen);
  }

  return merged;
}

/**
 * Comprueba sys_perm (sitio/postgressdb) o rol CMS (sys_morena/postgresMain) para syssubmod en default_sub_modules.
 */
async function grantorHasSyssubmodPerm(grantorId, syssubmodId, sysappId) {
  const uid = parseInt(grantorId, 10);
  const sid = parseInt(syssubmodId, 10);
  const aid = parseInt(sysappId, 10);
  if (!Number.isFinite(uid) || !Number.isFinite(sid) || !Number.isFinite(aid)) return false;

  const rows = await dbConection.query(
    `SELECT 1 FROM sys_perm
     WHERE fk_id_user = $1::integer
       AND fk_id_syssubmod = $2::integer
       AND fk_id_sysapp = $3::integer
       AND (vigente IS NOT FALSE)
     LIMIT 1`,
    { bind: [uid, sid, aid], type: QueryTypes.SELECT }
  );
  if (Array.isArray(rows) && rows.length > 0) return true;

  const cmsId = parseInt(process.env.CMS_SYSAPP, 10);
  if (!Number.isFinite(cmsId) || aid !== cmsId) return false;

  const sqlRole = `SELECT 1
       FROM rel_user_sysapp_roles rur
       INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
         AND crs.fk_id_sysapp = $3::integer
         AND (crs.vigente IS NOT FALSE)
         AND (rur.vigente IS NOT FALSE)
       WHERE rur.fk_id_user = $1::integer
         AND $2::integer = ANY (COALESCE(crs.default_sub_modules, ARRAY[]::integer[]))
       LIMIT 1`;
  const tryConn = async (conn) => {
    try {
      const roleRows = await conn.query(sqlRole, { bind: [uid, sid, aid], type: QueryTypes.SELECT });
      return Array.isArray(roleRows) && roleRows.length > 0;
    } catch (e) {
      const missing =
        e && ((e.parent && e.parent.code === '42P01') || (e.original && e.original.code === '42P01'));
      if (missing) return false;
      throw e;
    }
  };
  if (await tryConn(dbSysMorena)) return true;
  return tryConn(dbConection);
}

/**
 * Igual que usersmain.sqlSysmodNotConfiguracionGlobalGrant: no duplicar módulos de «configuración global» / admin general
 * al proyectar catálogo tipo 1 sobre apps de instancia (2/3).
 */
function sqlSysmodNotConfiguracionGlobalForInstance(aliasTable = 'm') {
  const t = (col) =>
    `translate(lower(trim(coalesce(${aliasTable}.${col}, ''))), 'áéíóúüñ', 'aeiouun')`;
  return `AND ${t('modulo')} NOT LIKE '%configuracion global%'
          AND ${t('modulo_legend')} NOT LIKE '%configuracion global%'
          AND ${t('modulo')} NOT LIKE '%administrador general%'
          AND ${t('modulo_legend')} NOT LIKE '%administrador general%'`;
}

/**
 * Igual que usersmain.sqlRutaExcludedFromBulkInstancePermGrant + exclusión de hosting (matriz admin / alta).
 */
function sqlRutaExcludedForTipo1ProjectedToInstance(aliasR = 'r') {
  const n = `translate(trim(both '/' from lower(replace(coalesce(${aliasR}.archivo, ''), '_', '-'))), 'áéíóúüñ', 'aeiouun')`;
  return `AND (${n} IS NULL OR ${n} = '' OR (${n} NOT IN ('users-instancia', 'instancias', 'hosting') AND ${n} NOT LIKE 'categorias%'))`;
}

/**
 * En "usuarios instancia" no deben aparecer permisos de administración de usuarios:
 * se gestionan solo desde el submódulo dedicado /users-instancia.
 */
function sqlRutaExcludedForInstanceUsersPerms(aliasR = 'r') {
  const n = `translate(trim(both '/' from lower(replace(coalesce(${aliasR}.archivo, ''), '_', '-'))), 'áéíóúüñ', 'aeiouun')`;
  return `AND (${n} IS NULL OR ${n} = '' OR (${n} NOT IN ('users', 'users-instancia') AND ${n} NOT LIKE 'users/%'))`;
}

/**
 * Por si `r.archivo` en BD no es literalmente `users` (legado o variante), excluir el bloque de UI
 * «Administrador de usuarios» sin ocultar «Usuarios instancia».
 */
function sqlLegendExcludedAdminUsuariosEnInstancia(aliasS = 's', aliasM = 'm') {
  const leg = (alias, col) =>
    `translate(lower(trim(coalesce(${alias}.${col}, ''))), 'áéíóúüñ', 'aeiouun')`;
  const sub = leg(aliasS, 'submodulo_legend');
  const mod = leg(aliasM, 'modulo_legend');
  return `AND NOT (
    ${sub} LIKE '%administrador de usuarios%'
    OR ${mod} LIKE '%administrador de usuarios%'
    OR (${sub} LIKE '%administrador%' AND ${sub} LIKE '%usuarios%' AND ${sub} NOT LIKE '%instancia%')
    OR (${mod} LIKE '%administrador%' AND ${mod} LIKE '%usuarios%' AND ${mod} NOT LIKE '%instancia%')
  )`;
}

/** FROM común: rutas → instancias del grupo (tipo 2 o 3). */
function fromRutasToInstanceApps(gid) {
  return `FROM rutas r
                                       INNER JOIN syssubmod s ON s.fk_id_ruta = r.id_ruta
                                       INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                                       INNER JOIN sysapp_group g ON g.id_sysapp_group = m.fk_id_sysapp_group
                                       INNER JOIN sysapp_type sat ON sat.id_sysapp_type = m.fk_id_sysapp_type
                                       INNER JOIN sysapp sa ON sa.fk_id_sysapp_type IN (2, 3)
                                       INNER JOIN rel_sysapp_group rl ON rl.fk_id_sysapp = sa.id_sysapp
                                         AND rl.fk_id_sysapp_group = ${gid}`;
}

/**
 * Matriz de permisos para asignar desde usuarios de instancia: solo apps permitidas;
 * `perm_type` = el responsable (grantor) puede otorgar ese submódulo en esa app.
 */
function getAdminViewForGrantor(grantorId, targetId, targetTypeId, allowedSysappIds) {
  const grantor = parseInt(grantorId, 10);
  const uid = parseInt(targetId, 10);
  const tid = parseInt(targetTypeId, 10);
  const gid = parseInt(process.env.GRUPO_APLICACIONES, 10);
  const allowed = Array.isArray(allowedSysappIds)
    ? allowedSysappIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
    : [];
  if (!Number.isFinite(grantor) || !Number.isFinite(uid) || !Number.isFinite(tid) || !Number.isFinite(gid) || !allowed.length) {
    return Promise.reject(new Error('getAdminViewForGrantor: parámetros inválidos o sin instancias'));
  }
  const allowedSql = allowed.join(',');
  const selGrantor = `SELECT sat.type_name AS type_name,
                                    sat.id_sysapp_type AS id_sysapp_type,
                                    sa.app_legend AS app_legend,
                                    sa.id_sysapp AS id_sysapp,
                                    m.modulo_legend,
                                    m.micon,
                                    m.id_sysmod,
                                    m.order_mod AS order_mod,
                                    s.submodulo_legend,
                                    s.id_syssubmod,
                                    r.archivo,
                                    s.submodulo_legend AS legend,
                                    s.smicon,
                                    s.order_submod AS order_submod,
                                     EXISTS (
                                       SELECT 1 FROM sys_perm sp
                                       WHERE sp.fk_id_user = ${uid}
                                         AND sp.fk_id_syssubmod = s.id_syssubmod
                                         AND sp.fk_id_sysapp = sa.id_sysapp
                                         AND (sp.vigente IS NOT FALSE)
                                     ) AS perm_user,
                                     EXISTS (
                                       SELECT 1 FROM sys_perm spg
                                       WHERE spg.fk_id_user = ${grantor}
                                         AND spg.fk_id_syssubmod = s.id_syssubmod
                                         AND spg.fk_id_sysapp = sa.id_sysapp
                                         AND (spg.vigente IS NOT FALSE)
                                     ) AS perm_type`;
  const fromMatchType = `FROM rutas r
                                       INNER JOIN syssubmod s ON s.fk_id_ruta = r.id_ruta
                                       INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                                       INNER JOIN sysapp_group g ON g.id_sysapp_group = m.fk_id_sysapp_group
                                       INNER JOIN sysapp_type sat ON sat.id_sysapp_type = m.fk_id_sysapp_type
                                       INNER JOIN sysapp sa ON sa.fk_id_sysapp_type = sat.id_sysapp_type
                                       INNER JOIN rel_sysapp_group rl ON rl.fk_id_sysapp = sa.id_sysapp
                                         AND rl.fk_id_sysapp_group = ${gid}`;
  const fromTipo1OnInstance = fromRutasToInstanceApps(gid);
  return dbConection.query(
    `${selGrantor}
                              ${fromMatchType}
                              WHERE m.fk_id_sysapp_group = ${gid}
                                AND r.vigente IS TRUE
                                AND s.vigente IS NOT FALSE
                                AND m.vigente IS NOT FALSE
                                AND g.vigente IS NOT FALSE
                                AND sa.vigente IS NOT FALSE
                                AND sa.id_sysapp IN (${allowedSql})
                                ${sqlRutaExcludedForInstanceUsersPerms('r')}
                                ${sqlLegendExcludedAdminUsuariosEnInstancia('s', 'm')}
                            UNION ALL
                            ${selGrantor}
                              ${fromTipo1OnInstance}
                              WHERE m.fk_id_sysapp_group = ${gid}
                                AND m.fk_id_sysapp_type = 1
                                AND r.vigente IS TRUE
                                AND s.vigente IS NOT FALSE
                                AND m.vigente IS NOT FALSE
                                AND g.vigente IS NOT FALSE
                                AND sa.vigente IS NOT FALSE
                                AND sa.id_sysapp IN (${allowedSql})
                                ${sqlSysmodNotConfiguracionGlobalForInstance('m')}
                                ${sqlRutaExcludedForTipo1ProjectedToInstance('r')}
                                ${sqlRutaExcludedForInstanceUsersPerms('r')}
                                ${sqlLegendExcludedAdminUsuariosEnInstancia('s', 'm')}
                            UNION ALL
                            ${selGrantor}
                              ${fromTipo1OnInstance}
                              WHERE m.fk_id_sysapp_group = ${gid}
                                AND m.fk_id_sysapp_type IN (2, 3)
                                AND sa.fk_id_sysapp_type IN (2, 3)
                                AND m.fk_id_sysapp_type <> sa.fk_id_sysapp_type
                                AND r.vigente IS TRUE
                                AND s.vigente IS NOT FALSE
                                AND m.vigente IS NOT FALSE
                                AND g.vigente IS NOT FALSE
                                AND sa.vigente IS NOT FALSE
                                AND sa.id_sysapp IN (${allowedSql})
                                ${sqlRutaExcludedForInstanceUsersPerms('r')}
                                ${sqlLegendExcludedAdminUsuariosEnInstancia('s', 'm')}
                              ORDER BY id_sysapp_type, id_sysapp, order_mod, order_submod`,
    { type: QueryTypes.SELECT }
  );
}

function getAdminView(id_user, id_type) {
  const uid = parseInt(id_user, 10);
  const tid = parseInt(id_type, 10);
  const gid = parseInt(process.env.GRUPO_APLICACIONES, 10);
  if (!Number.isFinite(uid) || !Number.isFinite(tid) || !Number.isFinite(gid)) {
    return Promise.reject(new Error('getAdminView: id_user, id_type o GRUPO_APLICACIONES no son enteros válidos'));
  }

  const selAdmin = `SELECT sat.type_name AS type_name,
                                    sat.id_sysapp_type AS id_sysapp_type,
                                    sa.app_legend AS app_legend,
                                    sa.id_sysapp AS id_sysapp,
                                    m.modulo_legend,
                                    m.micon,
                                    m.id_sysmod,
                                    m.order_mod AS order_mod,
                                    s.submodulo_legend,
                                    s.id_syssubmod,
                                    r.archivo,
                                    s.submodulo_legend AS legend,
                                    s.smicon,
                                    s.order_submod AS order_submod,
                                     EXISTS (
                                       SELECT 1 FROM sys_perm sp
                                       WHERE sp.fk_id_user = ${uid}
                                         AND sp.fk_id_syssubmod = s.id_syssubmod
                                         AND sp.fk_id_sysapp = sa.id_sysapp
                                         AND (sp.vigente IS NOT FALSE)
                                     ) AS perm_user,
                                     EXISTS (
                                       SELECT 1 FROM usertype_perm up
                                       CROSS JOIN usertype_app ut
                                       WHERE up.fk_id_type_usrsys = ${tid}
                                         AND ut.fk_id_cat_type_users = ${tid}
                                         AND up.fk_id_syssubmod = s.id_syssubmod
                                         AND ut.fk_id_sysapp = sa.id_sysapp
                                         AND (up.vigente IS NOT FALSE)
                                         AND (ut.vigente IS NOT FALSE)
                                     ) AS perm_type`;
  const fromMatchType = `FROM rutas r
                                       INNER JOIN syssubmod s ON s.fk_id_ruta = r.id_ruta
                                       INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                                       INNER JOIN sysapp_group g ON g.id_sysapp_group = m.fk_id_sysapp_group
                                       INNER JOIN sysapp_type sat ON sat.id_sysapp_type = m.fk_id_sysapp_type
                                       INNER JOIN sysapp sa ON sa.fk_id_sysapp_type = sat.id_sysapp_type
                                       INNER JOIN rel_sysapp_group rl ON rl.fk_id_sysapp = sa.id_sysapp
                                         AND rl.fk_id_sysapp_group = ${gid}`;
  const fromTipo1OnInstance = fromRutasToInstanceApps(gid);
  return dbConection.query(
    `${selAdmin}
                              ${fromMatchType}
                              WHERE m.fk_id_sysapp_group = ${gid}
                                AND r.vigente IS TRUE
                                AND s.vigente IS NOT FALSE
                                AND m.vigente IS NOT FALSE
                                AND g.vigente IS NOT FALSE
                                AND sa.vigente IS NOT FALSE
                            UNION ALL
                            ${selAdmin}
                              ${fromTipo1OnInstance}
                              WHERE m.fk_id_sysapp_group = ${gid}
                                AND m.fk_id_sysapp_type = 1
                                AND r.vigente IS TRUE
                                AND s.vigente IS NOT FALSE
                                AND m.vigente IS NOT FALSE
                                AND g.vigente IS NOT FALSE
                                AND sa.vigente IS NOT FALSE
                                ${sqlSysmodNotConfiguracionGlobalForInstance('m')}
                                ${sqlRutaExcludedForTipo1ProjectedToInstance('r')}
                            UNION ALL
                            ${selAdmin}
                              ${fromTipo1OnInstance}
                              WHERE m.fk_id_sysapp_group = ${gid}
                                AND m.fk_id_sysapp_type IN (2, 3)
                                AND sa.fk_id_sysapp_type IN (2, 3)
                                AND m.fk_id_sysapp_type <> sa.fk_id_sysapp_type
                                AND r.vigente IS TRUE
                                AND s.vigente IS NOT FALSE
                                AND m.vigente IS NOT FALSE
                                AND g.vigente IS NOT FALSE
                                AND sa.vigente IS NOT FALSE
                              ORDER BY id_sysapp_type, id_sysapp, order_mod, order_submod`,
    { type: QueryTypes.SELECT }
  );
}

module.exports = {
  getPermisos,
  getAdminView,
  getAdminViewForGrantor,
  grantorHasSyssubmodPerm,
};
