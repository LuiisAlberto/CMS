const { Op } = require('sequelize');
const usersModelMain = require('../models/usersmain');
const sysappModel = require('../models/AppsModel');

/** Tipo sysapp "admin usuarios" — no es instancia de contenido. */
const ADMIN_SYSAPP_TYPE = 1;

/**
 * Instancias (sysapp id) que el menú expone como apps tipo 2/3 (excluye tipo 1).
 * @param {Object} usdata - req.usdata con modulos
 * @returns {number[]}
 */
function allowedInstanceTypesFromMenu(usdata) {
  if (!usdata || !usdata.modulos || typeof usdata.modulos !== 'object') return [];
  const ids = new Set();
  for (const app of Object.values(usdata.modulos)) {
    const idSysapp = app && app.id != null ? parseInt(app.id, 10) : null;
    const t = app && app.id_sysapp_type != null ? parseInt(app.id_sysapp_type, 10) : null;
    if (
      idSysapp != null &&
      !isNaN(idSysapp) &&
      t != null &&
      !isNaN(t) &&
      t !== ADMIN_SYSAPP_TYPE &&
      (t === 2 || t === 3)
    ) {
      ids.add(idSysapp);
    }
  }
  return Array.from(ids);
}

/**
 * ids sysapp tipo 2/3 vigentes (catálogo de instancias).
 * @returns {Promise<Set<number>>}
 */
async function getValidInstanceSysappIdSet() {
  const rows = await sysappModel.findAll({
    attributes: ['id_sysapp'],
    where: {
      fk_id_sysapp_type: { [Op.in]: [2, 3] },
      vigente: true
    },
    raw: true
  });
  return new Set((rows || []).map((r) => parseInt(r.id_sysapp, 10)).filter((n) => Number.isFinite(n)));
}

/**
 * Alcance de datos por instancia: prioriza sysapp_user_perm (asignadas);
 * si no hay filas, usa el menú (administradores sin filas de asignación).
 * El submódulo «usuarios instancia» no usa esta función: allí solo aplica
 * getAssignedInstanceIdsIntersectValid (sin fallback al menú).
 *
 * @param {import('express').Request} req
 * @param {Set<number>} validSysappIdSet - típicamente instancias tipo 2/3 vigentes
 * @returns {Promise<number[]>}
 */
async function getScopedInstanceSysappIds(req, validSysappIdSet) {
  const uid =
    req.usdata && req.usdata.id_user != null ? parseInt(req.usdata.id_user, 10) : NaN;
  if (!Number.isFinite(uid) || !(validSysappIdSet instanceof Set) || validSysappIdSet.size === 0) {
    return [];
  }

  const assigned = await usersModelMain.getAssignedInstanceIdsForUser(uid);
  const fromAssignment = assigned.filter((id) => validSysappIdSet.has(id));
  if (fromAssignment.length > 0) {
    return fromAssignment;
  }

  return allowedInstanceTypesFromMenu(req.usdata).filter((id) => validSysappIdSet.has(id));
}

/**
 * Misma regla que getScopedInstanceSysappIds cargando el set válido desde BD.
 * @param {import('express').Request} req
 * @returns {Promise<number[]>}
 */
async function getScopedInstanceSysappIdsResolved(req) {
  const validSet = await getValidInstanceSysappIdSet();
  return getScopedInstanceSysappIds(req, validSet);
}

/**
 * Instancias asignadas (sysapp_user_perm) ∩ tipo 2/3. Sin fallback al menú:
 * listado/validación en /users-instancia y cruce permisos entre usuarios.
 * @param {number|string} userId
 * @param {Set<number>} validSysappIdSet
 * @returns {Promise<number[]>}
 */
async function getAssignedInstanceIdsIntersectValid(userId, validSysappIdSet) {
  const uid = parseInt(userId, 10);
  if (!Number.isFinite(uid) || !(validSysappIdSet instanceof Set)) return [];
  const assigned = await usersModelMain.getAssignedInstanceIdsForUser(uid);
  return assigned.filter((id) => validSysappIdSet.has(id));
}

/**
 * Menú lateral para responsable: apps que ya vienen de getPermisos (sys_perm / roles).
 * - Tipo 1 (Administrador general), 2 (nacional) y 3 (secundarias): si hay filas de permiso para ese
 *   id_sysapp, deben mostrarse. Antes solo se filtraba tipo 3 por sysapp_user_perm; la nacional (2) no
 *   pasaba por esa lista y podía desincronizarse: el usuario veía solo la nacional aunque tuviera
 *   sys_perm en una secundaria.
 */
function filterModulosForResponsableMenu(arr_modulos) {
  if (!arr_modulos || typeof arr_modulos !== 'object') return arr_modulos;
  const out = {};
  for (const k of Object.keys(arr_modulos)) {
    const app = arr_modulos[k];
    const t = parseInt(app.id_sysapp_type, 10);
    const id = parseInt(app.id, 10);
    if (!Number.isFinite(id)) continue;
    if (t === 1 || t === 2 || t === 3) {
      out[k] = app;
    }
  }
  return out;
}

/**
 * Si el perfil es responsable de instancia, aplica filterModulosForResponsableMenu tras cargar permisos.
 */
async function applyResponsableMenuFilterIfNeeded(arr_modulos, usdata) {
  const typeLower = String(usdata?.type_user || '').toLowerCase();
  if (!typeLower.includes('responsable')) return arr_modulos;
  return filterModulosForResponsableMenu(arr_modulos);
}

/** Valor típico en BD para «Administrador» en registro /users (puede no coincidir en todas las bases). */
const CAT_TYPE_ADMINISTRADOR = 1;

/**
 * Perfil «administrador global» del módulo /users: no confundir con responsable de instancia.
 * Algunas BD usan otro id_cat_type_users; el label suele ser «Administrador».
 */
function isAdministradorGlobalMenuUser(usdata) {
  const typeLower = String(usdata?.type_user || '')
    .toLowerCase()
    .trim();
  if (typeLower.includes('responsable')) return false;
  const tidRaw = usdata?.fk_id_cat_type_users;
  const tid = tidRaw != null && tidRaw !== '' ? parseInt(String(tidRaw), 10) : NaN;
  if (Number.isFinite(tid) && tid === CAT_TYPE_ADMINISTRADOR) return true;
  if (typeLower === 'administrador') return true;
  return false;
}

/**
 * Si el catálogo trae varias sysapp tipo 1 en el grupo, el menú repetía carpetas (p. ej. Contenido/Documentos).
 * Preferimos la que se llame «Administrador general», si no la de menor id_sysapp.
 */
function pickSingleTipo1App(arr_modulos) {
  const tipo1 = [];
  for (const k of Object.keys(arr_modulos)) {
    const app = arr_modulos[k];
    const t = parseInt(app.id_sysapp_type, 10);
    if (!Number.isFinite(t) || t !== ADMIN_SYSAPP_TYPE) continue;
    tipo1.push({
      key: k,
      app,
      id: parseInt(app.id, 10),
      name: String(app.app_name || ''),
    });
  }
  if (tipo1.length === 0) return null;
  if (tipo1.length === 1) return { key: tipo1[0].key, app: tipo1[0].app };
  const hinted = tipo1.filter((x) => /administrador\s+general/i.test(x.name));
  const pool = hinted.length ? hinted : tipo1;
  pool.sort((a, b) => {
    if (Number.isFinite(a.id) && Number.isFinite(b.id)) return a.id - b.id;
    return String(a.key).localeCompare(String(b.key));
  });
  return { key: pool[0].key, app: pool[0].app };
}

/**
 * Misma leyenda de submódulo con distinto id_syssubmod (p. ej. filas catálogo tipo 2 y 3): una sola fila en UI.
 */
function dedupeSubmodulosMismaLeyenda(modulo) {
  if (!modulo?.submodulos || typeof modulo.submodulos !== 'object') return modulo;
  const byLeg = new Map();
  const sids = Object.keys(modulo.submodulos).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10)
  );
  for (const sid of sids) {
    const sub = modulo.submodulos[sid];
    const raw = String(sub?.legend || '')
      .trim()
      .toLowerCase();
    const key = raw || `_id_${sid}`;
    if (!byLeg.has(key)) {
      byLeg.set(key, sid);
    }
  }
  const next = {};
  for (const sid of byLeg.values()) {
    next[sid] = modulo.submodulos[sid];
  }
  return {
    ...modulo,
    submodulos: next,
    submod_count: Object.keys(next).length,
  };
}

/**
 * Dos sysmod distintos con el mismo título (p. ej. «Contenido») duplicaban entradas en el acordeón.
 */
function dedupeModulosMismaLeyenda(app) {
  if (!app || !app.modulos || typeof app.modulos !== 'object') return app;
  const byLegend = new Map();
  const out = {};
  for (const mid of Object.keys(app.modulos)) {
    const modulo = app.modulos[mid];
    const leg = String(modulo.mod_legend || '')
      .trim()
      .toLowerCase();
    if (!leg) {
      out[mid] = modulo;
      continue;
    }
    if (!byLegend.has(leg)) {
      byLegend.set(leg, mid);
      out[mid] = { ...modulo, submodulos: { ...(modulo.submodulos || {}) } };
      continue;
    }
    const keepMid = byLegend.get(leg);
    const keep = out[keepMid];
    const subs = modulo.submodulos || {};
    for (const sid of Object.keys(subs)) {
      const subLeg = String(subs[sid]?.legend || '')
        .trim()
        .toLowerCase();
      const already =
        subLeg &&
        Object.values(keep.submodulos || {}).some(
          (ex) =>
            String(ex?.legend || '')
              .trim()
              .toLowerCase() === subLeg
        );
      if (already) continue;
      if (!keep.submodulos[sid]) {
        keep.submodulos[sid] = subs[sid];
      }
    }
    keep.submod_count = Object.keys(keep.submodulos).length;
  }
  for (const mid of Object.keys(out)) {
    out[mid] = dedupeSubmodulosMismaLeyenda(out[mid]);
  }
  const modCount = Object.keys(out).length;
  return { ...app, modulos: out, mod_count: modCount };
}

/**
 * Menú lateral: deduplica el árbol de la app tipo 1 («Administrador general», etc.) cuando hay varias sysapp tipo 1
 * o módulos con la misma leyenda. Conserva todas las apps de instancia (tipo 2 y 3) para perfiles con acceso
 * a todo el grupo (p. ej. super admin); antes se eliminaban y el menú solo mostraba la carpeta tipo 1.
 */
function filterModulosAdminGeneralOnly(arr_modulos) {
  if (!arr_modulos || typeof arr_modulos !== 'object') return arr_modulos;
  const chosen = pickSingleTipo1App(arr_modulos);
  if (!chosen) return arr_modulos;
  const app = dedupeModulosMismaLeyenda(chosen.app);
  const out = { [chosen.key]: app };
  for (const k of Object.keys(arr_modulos)) {
    if (k === chosen.key) continue;
    const a = arr_modulos[k];
    const t = parseInt(a && a.id_sysapp_type, 10);
    if (Number.isFinite(t) && (t === 2 || t === 3)) {
      out[k] = a;
    }
  }
  return out;
}

/**
 * Aplica filterModulosAdminGeneralOnly si el usuario es administrador global y no responsable de instancia.
 */
function applyAdminGeneralMenuFilterIfNeeded(arr_modulos, usdata) {
  if (!isAdministradorGlobalMenuUser(usdata)) return arr_modulos;
  return filterModulosAdminGeneralOnly(arr_modulos);
}

module.exports = {
  allowedInstanceTypesFromMenu,
  getScopedInstanceSysappIds,
  getScopedInstanceSysappIdsResolved,
  getValidInstanceSysappIdSet,
  getAssignedInstanceIdsIntersectValid,
  filterModulosForResponsableMenu,
  applyResponsableMenuFilterIfNeeded,
  filterModulosAdminGeneralOnly,
  applyAdminGeneralMenuFilterIfNeeded,
  isAdministradorGlobalMenuUser,
  dedupeModulosMismaLeyenda,
};
