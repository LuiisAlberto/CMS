/**
 * El submódulo /users-instancia es único a nivel funcional (lista usuarios por instancias asignadas).
 * getPermisos devuelve una fila por instancia → el menú repetía el mismo enlace bajo cada app.
 *
 * Importante: no mutar el árbol `modulos` aquí (rompía mod_count/submódulos y podía vaciar el menú).
 * Solo calculamos en qué app debe mostrarse el enlace; el filtrado se hace en `partials/menu.ejs`.
 */

function normArchivo(a) {
  return String(a || '')
    .trim()
    .toLowerCase()
    .replace(/^\//, '');
}

function isUsersInstanciaSubmod(sub) {
  const a = normArchivo(sub && sub.archivo);
  return a === 'users-instancia';
}

function appTieneUsersInstanciaEnArbol(app) {
  if (!app || !app.modulos) return false;
  return Object.values(app.modulos).some((modulo) =>
    Object.values(modulo.submodulos || {}).some((s) => isUsersInstanciaSubmod(s))
  );
}

/**
 * Si hay varias apps con "users-instancia", devuelve el id_sysapp donde debe mostrarse el enlace.
 * Prioridad: app «Administrador general» (tipo 1), luego nacional (tipo 2), luego menor id entre 2/3.
 * Si no hay duplicado funcional, null.
 */
function getPreferredUsersInstanciaAppId(arr_modulos) {
  if (!arr_modulos || typeof arr_modulos !== 'object') return null;

  const candidatos = [];
  Object.keys(arr_modulos).forEach((k) => {
    const id = parseInt(k, 10);
    const app = arr_modulos[k];
    if (!Number.isFinite(id) || !appTieneUsersInstanciaEnArbol(app)) return;
    const t = parseInt(app.id_sysapp_type, 10);
    candidatos.push({ id, type: Number.isFinite(t) ? t : null });
  });

  if (candidatos.length <= 1) return null;

  const adminGral = candidatos.filter((c) => c.type === 1);
  if (adminGral.length) {
    adminGral.sort((a, b) => a.id - b.id);
    return adminGral[0].id;
  }

  const nacionales = candidatos.filter((c) => c.type === 2);
  if (nacionales.length) {
    nacionales.sort((a, b) => a.id - b.id);
    return nacionales[0].id;
  }

  const instancia = candidatos.filter((c) => c.type === 2 || c.type === 3);
  const elegidos = instancia.length ? instancia : candidatos;
  elegidos.sort((a, b) => a.id - b.id);
  return elegidos[0].id;
}

module.exports = {
  getPreferredUsersInstanciaAppId,
  isUsersInstanciaSubmod
};
