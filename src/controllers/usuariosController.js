const userModel = require('../models/users');
const usersModelMain = require('../models/usersmain');
const CatalogModel = require('../models/CatalogModel');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { renapoConsultarCurp } = require('../util/WebServices');
const { genCode } = require('../util/util');
const { enviarEmail } = require('../util/util');
const PGconn = require('../config/postgressdb');
const pgMain = require('../config/postgresMain');
const { Op, QueryTypes, Sequelize } = require('sequelize');
const {
  TIPO_PRINCIPAL,
  TIPO_INTERIOR,
  TIPO_ENTRADA,
  TIPO_REGENERACION,
} = require('../util/editorPaginaScope');
const { isUsersInstanciaSubmod } = require('../util/dedupeUsersInstanciaMenu');
const {
  getValidInstanceSysappIdSet,
  getAssignedInstanceIdsIntersectValid,
  dedupeModulosMismaLeyenda,
} = require('../util/instanceScope');
const paginaModel = require('../models/paginasModel');
const { registraBitacora, ACCION: BITACORA } = require('../util/bitacora');

/** Solo estos tipos pueden elegirse al registrar/editar usuarios: 1 = Administrador, 13 = Editor */
const idsTipoUsuarioRegistro = [1, 13];
const idsTipoUsuarioInstancia = [13];
const INSTANCE_USERS_PATH = '/users-instancia';

function normalizeEmailKey(value) {
  return String(value || '').trim().toLowerCase();
}

/** Solo cuando el admin cambió explícitamente el correo respecto al guardado en `users`. */
function emailFueAlteradoEnFormulario(correoPayloadTrim, correoActualTrim) {
  if (!String(correoPayloadTrim || '').length) return false;
  return normalizeEmailKey(correoPayloadTrim) !== normalizeEmailKey(correoActualTrim);
}

function dispararBitacoraAltaUsuarioCms(req, { tipo, scope, selectedInstanceIds, idUsuarioAfectado }) {
  const actor = req.usdata && req.usdata.id_user;
  const idAf = parseInt(idUsuarioAfectado, 10);
  if (!actor || !Number.isFinite(idAf)) return;
  const t = Number(tipo);
  const instancias = Array.isArray(selectedInstanceIds) ? selectedInstanceIds : null;
  const detalle = { scope, tipo_cat: t, instancias };
  if (t === 1 && scope === 'super') {
    void registraBitacora({
      fk_id_user_actor: actor,
      accion: BITACORA.USUARIO_ADMIN_CMS_ALTA,
      fk_id_user_afectado: idAf,
      detalle,
      req,
    });
  } else if (t === 13) {
    const fkSys = instancias && instancias.length === 1 ? instancias[0] : null;
    void registraBitacora({
      fk_id_user_actor: actor,
      accion: BITACORA.USUARIO_EDITOR_ALTA,
      fk_id_sysapp: fkSys,
      fk_id_user_afectado: idAf,
      detalle,
      req,
    });
  }
}

/** Evita Number(null)===0: solo rechazar si el tipo en BD es un id conocido distinto de Editor. */
function getCatTypeUsersIdFromRow(userRow) {
  if (!userRow) return null;
  const raw =
    typeof userRow.getDataValue === 'function'
      ? userRow.getDataValue('fk_id_cat_type_users')
      : userRow.fk_id_cat_type_users;
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Administrador de usuarios (/users): no pisar `fk_id_cat_type_users` si el usuario ya trae un tipo
 * fuera del catálogo CMS (1/13), para no afectar otros sistemas. Solo sincronizar la columna cuando
 * el valor actual es NULL (alta incompleta) o ya es 1/13 y el admin elige el otro tipo CMS.
 * El tipo elegido en UI sigue aplicándose a rol/permisos vía `resolveCmsRoleIdByCatTypeUsers` + `rel_user_sysapp_roles`.
 */
function shouldPreserveFkCatTypeUsersOnSuperAdminSave(currentTypeId, requestedTypeId) {
  const req = parseInt(requestedTypeId, 10);
  if (!Number.isFinite(req) || !idsTipoUsuarioRegistro.includes(req)) return true;
  if (currentTypeId == null) return false;
  if (!idsTipoUsuarioRegistro.includes(currentTypeId)) return true;
  if (currentTypeId === req) return true;
  return false;
}

function hasArchivoAccess(req, expectedArchivo) {
  const expected = String(expectedArchivo || '').trim().toLowerCase();
  if (!expected) return false;
  const apps = Object.values(req.usdata?.modulos || {});
  return apps.some((app) =>
    Object.values(app?.modulos || {}).some((modulo) =>
      Object.values(modulo?.submodulos || {}).some((submod) => {
        const archivo = String(submod?.archivo || '').trim().toLowerCase();
        return archivo === expected || archivo === expected.replace(/^\//, '');
      })
    )
  );
}

function getScopeFromRequest(req) {
  const requestedScope = String(req.body?.usuarios_scope || '').toLowerCase();
  if (requestedScope === 'instance') return 'instance';
  /** Lo pone ensureInstanceUsersAccess: no depender solo de req.path (barra final, proxies). */
  if (req.usuariosScope === 'instance') return 'instance';
  const p = String(req.path || '')
    .toLowerCase()
    .replace(/\/+$/, '');
  return p === INSTANCE_USERS_PATH ? 'instance' : 'super';
}

/**
 * Alta por responsable: el POST va a /NuevoUsuario (path no es /users-instancia) y a veces no llega
 * `usuarios_scope` en el cuerpo; si hay instancias elegidas y el usuario puede gestionar instancias,
 * debe tratarse como scope `instance` para rellenar fk_id_user_asignador en sysapp_user_perm (si no, el
 * editor no aparece en la lista de usuarios instancia).
 */
function resolveUsuariosScopeForAlta(req, canInstance) {
  let scope = getScopeFromRequest(req);
  if (scope !== 'instance' && canInstance) {
    const ids = parseInstanceIdsFromBody(req.body);
    if (ids.length > 0) {
      scope = 'instance';
    }
  }
  return scope;
}

function parseInstanceIdsFromBody(body) {
  const raw = body?.instancias_ids;
  let values = [];
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'string' && raw.trim()) values = raw.split(',');
  return values
    .map((v) => parseInt(String(v).trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function normalizeInstanceDomainDisplay(urluri) {
  if (!urluri || typeof urluri !== 'string') return '';
  return urluri.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** Ítems de lista para el correo: nombre en negrita + «Dominio de la instancia: …» si hay urluri en catálogo. */
function buildInstanceAssignmentListHtml(instanceIds) {
  const ids = Array.isArray(instanceIds) ? instanceIds.map((n) => Number(n)) : [];
  const apps = Array.isArray(global.catalogos?.cat_apps_activas) ? global.catalogos.cat_apps_activas : [];
  if (!ids.length) {
    return '<li>(Sin detalle de instancia)</li>';
  }
  return ids
    .map((id) => {
      const app = apps.find((a) => Number(a.id_sysapp) === id);
      const name = app?.app_legend || app?.sysapp_name || `Instancia ${id}`;
      const domain = normalizeInstanceDomainDisplay(app?.urluri || '');
      const domainLine = domain
        ? `<p style="margin:4px 0 0 0; font-size:0.95rem; color:#555;">Dominio de la instancia: ${domain}</p>`
        : '';
      return `<li style="margin-bottom:12px;"><strong>${name}</strong>${domainLine}</li>`;
    })
    .join('');
}

async function assignUserToInstances(userId, instanceIds, creatorUserId, opts = {}) {
  const copyCreatorSysPerm = opts.copyCreatorSysPerm !== false;
  const uid = parseInt(userId, 10);
  const creator = parseInt(creatorUserId, 10);
  const ids = Array.isArray(instanceIds)
    ? instanceIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
    : [];
  if (!Number.isFinite(uid) || !ids.length) return;

  for (const instanceId of ids) {
    const asignador =
      Number.isFinite(creator) && creator > 0 ? creator : null;
    await pgMain.query(
      `INSERT INTO sysapp_user_perm (fk_id_sysapp, fk_id_user, activo, fecha_asignacion, fk_id_user_asignador)
       SELECT $1::integer, $2::integer, true, CURRENT_TIMESTAMP, $3::integer
       WHERE NOT EXISTS (
         SELECT 1 FROM sysapp_user_perm
         WHERE fk_id_sysapp = $1::integer
           AND fk_id_user = $2::integer
           AND (activo IS NOT FALSE)
       )`,
      {
        bind: [instanceId, uid, asignador],
        type: QueryTypes.INSERT,
      }
    );
    if (asignador != null) {
      await pgMain.query(
        `UPDATE sysapp_user_perm
         SET fk_id_user_asignador = $3::integer
         WHERE fk_id_sysapp = $1::integer
           AND fk_id_user = $2::integer
           AND (activo IS NOT FALSE)`,
        { bind: [instanceId, uid, asignador], type: QueryTypes.UPDATE }
      );
    }

    if (copyCreatorSysPerm && Number.isFinite(creator)) {
      await pgMain.query(
        `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
         SELECT $1::integer, sp.fk_id_syssubmod, sp.fk_id_sysapp
         FROM sys_perm sp
         LEFT JOIN sys_perm sp2
           ON sp2.fk_id_user = $1::integer
          AND sp2.fk_id_syssubmod = sp.fk_id_syssubmod
          AND sp2.fk_id_sysapp = sp.fk_id_sysapp
          AND (sp2.vigente IS NOT FALSE)
         WHERE sp.fk_id_user = $2::integer
           AND sp.fk_id_sysapp = $3::integer
           AND (sp.vigente IS NOT FALSE)
           AND sp2.id_sys_perm IS NULL`,
        {
          bind: [uid, creator, instanceId],
          type: QueryTypes.INSERT,
        }
      );
    }
    await usersModelMain.grantBulkSysPermForInstanceApp(uid, instanceId);
  }
}

async function sendInstanceAssignmentEmail({
  to,
  toName,
  instanceIds,
  includeCredentials = false,
  tempPassword = '',
}) {
  if (process.env.MAIL_ACTIVE !== 'true' || !to) return { success: false, skipped: true };

  const appBaseUrl = process.env.APP_BASE_URL != '' ? process.env.APP_BASE_URL : 'morena.org';
  const imagePathTop = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_2.png');
  const imagePathBottom = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_1.jpg');
  const instancesHtml = buildInstanceAssignmentListHtml(instanceIds);
  const accessBlock = includeCredentials
    ? `<div style="background-color:#f5f5f5; border:2px solid #B38E5D; border-radius:8px; padding:20px; margin:25px auto; max-width:450px;">
         <p style="margin:10px 0; font-weight:700; font-size:1rem; color:#235b4e;">USUARIO:</p>
         <p style="margin:5px 0; font-size:1.1rem; color:#000;">${to}</p>
         <p style="margin:15px 0 10px 0; font-weight:700; font-size:1rem; color:#235b4e;">CONTRASEÑA TEMPORAL:</p>
         <p style="margin:5px 0; font-size:1.3rem; font-weight:800; color:#8b1e1e;">${tempPassword}</p>
       </div>`
    : `<p style="margin:25px 0; font-size:15px; color:#333; text-align:center;">
         Ya cuentas con usuario registrado. Ingresa con los accesos que ya tenías.
       </p>`;

  const body = `<html>
      <body style="margin:0; padding:0; text-align:center;">
        <div style="max-width:800px; margin:0 auto; text-align:center;">
          <img src="cid:topImage" style="width:100%; max-width:800px; display:block;">
          <div style="max-width:600px; margin:0 auto; padding:30px 20px; font-family:Montserrat, Arial, sans-serif; color:#021B23; text-align:center;">
            <h2 style="font-weight:800; color:#235b4e; margin:20px 0; font-size:1.6rem;">ASIGNACION DE INSTANCIAS EN CMS</h2>
            <hr style="border:none; height:3px; width:120px; background-color:#B38E5D; margin:10px auto 25px auto;">
            ${accessBlock}
            <p style="color:#333; font-size:15px; text-align:left; line-height:1.6; margin:25px 0 10px;">Se te asignaron las siguientes instancias:</p>
            <ul style="text-align:left; max-width:420px; margin:0 auto 20px; color:#333; font-size:14px; line-height:1.6; list-style-position:inside; padding-left:0;">${instancesHtml}</ul>
            <p style="margin:20px 0; font-size:15px; color:#333; text-align:center;">Puedes ingresar al sistema desde:</p>
            <p style="margin:20px 0; text-align:center;">
              <a href="https://${appBaseUrl}/" style="display:inline-block; background-color:#b91c1c; color:#ffffff; font-weight:700; text-decoration:none; font-size:16px; padding:12px 28px; border-radius:6px; font-family:Montserrat, Arial, sans-serif;">Ingresa aquí</a>
            </p>
          </div>
          <img src="cid:bottomImage" style="width:100%; max-width:800px; display:block;">
        </div>
      </body>
    </html>`;

  return enviarEmail({
    to,
    to_name: toName || 'Usuario',
    subject: includeCredentials ? 'DATOS DE ACCESO Y ASIGNACION DE INSTANCIA' : 'ASIGNACION DE INSTANCIA CMS',
    body,
    isHTml: true,
    attachments: [
      { path: imagePathTop, filename: 'FIRMA_CORREO_MORENA_2.png', type: 'image/png', disposition: 'inline', cid: 'topImage' },
      { path: imagePathBottom, filename: 'FIRMA_CORREO_MORENA_1.jpg', type: 'image/jpeg', disposition: 'inline', cid: 'bottomImage' },
    ],
  });
}

/** Alta desde /users sin instancias: credenciales o aviso, sin texto de asignación de instancia. */
async function sendNewUserWelcomeEmail({
  to,
  toName,
  includeCredentials = false,
  tempPassword = '',
}) {
  if (process.env.MAIL_ACTIVE !== 'true' || !to) return { success: false, skipped: true };

  const appBaseUrl = process.env.APP_BASE_URL != '' ? process.env.APP_BASE_URL : 'morena.org';
  const imagePathTop = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_2.png');
  const imagePathBottom = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_1.jpg');
  const accessBlock = includeCredentials
    ? `<div style="background-color:#f5f5f5; border:2px solid #B38E5D; border-radius:8px; padding:20px; margin:25px auto; max-width:450px;">
         <p style="margin:10px 0; font-weight:700; font-size:1rem; color:#235b4e;">USUARIO:</p>
         <p style="margin:5px 0; font-size:1.1rem; color:#000;">${to}</p>
         <p style="margin:15px 0 10px 0; font-weight:700; font-size:1rem; color:#235b4e;">CONTRASEÑA TEMPORAL:</p>
         <p style="margin:5px 0; font-size:1.3rem; font-weight:800; color:#8b1e1e;">${tempPassword}</p>
       </div>`
    : `<p style="margin:25px 0; font-size:15px; color:#333; text-align:center;">
         Tu usuario ha sido registrado en el sistema. Ingresa con las credenciales que te proporcionó el administrador.
       </p>`;

  const body = `<html>
      <body style="margin:0; padding:0; text-align:center;">
        <div style="max-width:800px; margin:0 auto; text-align:center;">
          <img src="cid:topImage" style="width:100%; max-width:800px; display:block;">
          <div style="max-width:600px; margin:0 auto; padding:30px 20px; font-family:Montserrat, Arial, sans-serif; color:#021B23; text-align:center;">
            <h2 style="font-weight:800; color:#235b4e; margin:20px 0; font-size:1.6rem;">${includeCredentials ? 'DATOS DE ACCESO AL CMS' : 'REGISTRO EN CMS'}</h2>
            <hr style="border:none; height:3px; width:120px; background-color:#B38E5D; margin:10px auto 25px auto;">
            ${accessBlock}
            <p style="margin:20px 0; font-size:15px; color:#333; text-align:center;">Puedes ingresar al sistema desde:</p>
            <p style="margin:20px 0; text-align:center;">
              <a href="https://${appBaseUrl}/" style="color:#8b1e1e; font-weight:700; text-decoration:none; font-size:16px;">https://${appBaseUrl}/</a>
            </p>
          </div>
          <img src="cid:bottomImage" style="width:100%; max-width:800px; display:block;">
        </div>
      </body>
    </html>`;

  return enviarEmail({
    to,
    to_name: toName || 'Usuario',
    subject: includeCredentials ? 'DATOS DE ACCESO AL CMS' : 'REGISTRO EN CMS',
    body,
    isHTml: true,
    attachments: [
      { path: imagePathTop, filename: 'FIRMA_CORREO_MORENA_2.png', type: 'image/png', disposition: 'inline', cid: 'topImage' },
      { path: imagePathBottom, filename: 'FIRMA_CORREO_MORENA_1.jpg', type: 'image/jpeg', disposition: 'inline', cid: 'bottomImage' },
    ],
  });
}

/**
 * Determina si el correo se envió correctamente según el objeto que devuelve `enviarEmail`.
 * Incluye comprobación por `data.type` por si `success` no refleja el envío (estados inconsistentes).
 */
function envioCorreoExitoso(resultado) {
  if (!resultado) return false;
  if (resultado.success === true) return true;
  const tipo = resultado.data && resultado.data.type;
  if (tipo === 'sendgrid' || tipo === 'smtp' || tipo === 'azure') {
    return resultado.data.responseData != null;
  }
  return false;
}

function detalleFalloCorreo(resultado, err) {
  if (err && err.message) return err.message;
  const m = resultado && resultado.msg != null ? String(resultado.msg).trim() : '';
  if (m) return m;
  return 'No se pudo completar el envío del correo.';
}

async function users(req, res) {
  const scope = getScopeFromRequest(req);

  try {
    const validSet = await getValidInstanceSysappIdSet();
    const assignedInstances =
      scope === 'instance'
        ? await getAssignedInstanceIdsIntersectValid(req.usdata.id_user, validSet)
        : await usersModelMain.getAssignedInstanceIdsForUser(req.usdata.id_user);
    const usuarios =
      scope === 'instance'
        ? await usersModelMain.findEditorsByInstanceIdsForRegistrant(
            assignedInstances,
            req.usdata.id_user
          )
        : await usersModelMain.findAllBySysappGroup();
    console.log('[usuarios] Ingreso a administrador de usuarios. scope:', scope, 'Registros:', usuarios?.length ?? 0);
    if (scope === 'instance') {
      console.log(
        '[usuarios instancia] instancias del responsable (ids):',
        assignedInstances
      );
      console.log(
        '[usuarios instancia] usuarios (resumen):',
        (usuarios || []).map((u) => ({
          id_user: u.id_user,
          nombre: u.nombre,
          paterno: u.paterno,
          materno: u.materno,
          curp: u.curp,
          type_user: u.type_user,
          activo: u.activo,
          instancias_asignadas: u.instancias_asignadas,
        }))
      );
    }
    const catTypeUsers = global.catalogos.cat_type_users || [];
    const allowedTypes = scope === 'instance' ? idsTipoUsuarioInstancia : idsTipoUsuarioRegistro;
    const cat_type_users = catTypeUsers.filter(
      (t) => allowedTypes.includes(Number(t.id_cat_type_users))
    );
    const appsActivas = Array.isArray(global.catalogos?.cat_apps_activas)
      ? global.catalogos.cat_apps_activas
      : [];
    const idsEnCatalogo = new Set(appsActivas.map((a) => Number(a.id_sysapp)));
    const idsSinCatalogo = assignedInstances.filter((id) => !idsEnCatalogo.has(Number(id)));
    const extrasDb =
      idsSinCatalogo.length > 0
        ? await usersModelMain.getAppLegendsBySysappIds(idsSinCatalogo)
        : [];
    const extraPorId = {};
    (extrasDb || []).forEach((row) => {
      extraPorId[Number(row.id_sysapp)] = row.app_legend;
    });
    const assignedInstancesData = assignedInstances.map((id) => {
      const n = Number(id);
      const enCat = appsActivas.find((app) => Number(app.id_sysapp) === n);
      if (enCat) return { id_sysapp: enCat.id_sysapp, app_legend: enCat.app_legend };
      if (extraPorId[n] != null) return { id_sysapp: n, app_legend: extraPorId[n] };
      return { id_sysapp: n, app_legend: `Instancia (${n})` };
    });

    res.render('usuariosAcciones', {
      ...req.usdata,
      cat_type_users,
      cat_entidades_admins: global.catalogos.cat_entidad_federativa, //global.catalogos.cat_entidades_admins,
      sub_modulos: global.catalogos.sub_modulo, //sub_modulos,
      listaUsuarios: usuarios,
      directorio_activo: process.env.ACTIVE_DIRECTORY,
      usuarios_scope: scope,
      assigned_instances: assignedInstancesData,
    });
  } catch (error) {
    // await  registroBitacoraControl(id_user,'Administrador',req.body.NuevoUsuarioCurpValidada,500,'usuariosController.adduser  ::' + error.message);
    console.error('--->>> usuariosController.adduser ');
    console.error(error);
    res.status(500).json({ success: false, error: 1, message: 'Error' });
  }
}

async function adduser(req, res) {
  try {
    const canSuper = hasArchivoAccess(req, '/users');
    const canInstance = hasArchivoAccess(req, '/users-instancia');
    const scope = resolveUsuariosScopeForAlta(req, canInstance);
    if (scope === 'instance' && !canInstance) {
      return res.status(403).json({ success: false, msg: 'Sin acceso al submódulo de usuarios por instancia.' });
    }
    if (scope === 'super' && !canSuper) {
      return res.status(403).json({ success: false, msg: 'Sin acceso al módulo de usuarios.' });
    }
    if (process.env.ACTIVE_DIRECTORY == 'true') {
      //console.log('ruta de modulo ad activada');
      adduserAD(req, res);
    } else {
      //console.log('ruta de modulo ad no activada');
      addUserNoAd(req, res);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 1, message: 'Error' });
  }
}


async function addUserNoAd(req, res) {
  const curp = req.body.NuevoUsuarioCurpValidada.toString().trim();
  const correo = req.body.NuevoUsuarioCorreoConfirmar.toString().trim();
  const tipo = req.body.NuevoUsuarioTipo;
  const canInstance = hasArchivoAccess(req, '/users-instancia');
  const scope = resolveUsuariosScopeForAlta(req, canInstance);
  const allowedTypes = scope === 'instance' ? idsTipoUsuarioInstancia : idsTipoUsuarioRegistro;
  if (!allowedTypes.includes(Number(tipo))) {
    return res.json({ success: false, msg: 'Tipo de usuario no permitido' });
  }
  const nombre = req.body.NuevoUsuarioNombre;
  const telefono_fijo = req.body.NuevoUsuarioTelefonoFijo ?? ''; //  Campo comentado en vista - Descomentar en caso de usarse
  const telefono_celular = req.body.NuevoUsuarioTelefonoCelular ?? ''; // Campo comentado en vista - Descomentar en caso de usarse
  const fk_id_estado = req.body.NuevoUsuarioEntidad || null; // Campo comentado en vista - Descomentar en caso de usarse
  const primer_apellido = req.body.NuevoUsuarioPrimerA;
  const segundo_apellido = req.body.NuevoUsuarioSegundoA;
  try {
    let assignedInstances = [];
    if (scope === 'instance') {
      const validSet = await getValidInstanceSysappIdSet();
      assignedInstances = await getAssignedInstanceIdsIntersectValid(req.usdata.id_user, validSet);
    }
    let selectedInstanceIds = parseInstanceIdsFromBody(req.body);
    if (scope === 'instance') {
      if (!selectedInstanceIds.length) {
        return res.json({ success: false, msg: 'Selecciona al menos una instancia.' });
      }
      const invalidIds = selectedInstanceIds.filter((id) => !assignedInstances.includes(id));
      if (invalidIds.length) {
        return res.json({ success: false, msg: 'Instancias seleccionadas no válidas para este usuario.' });
      }
    } else if (selectedInstanceIds.length === 0) {
      // Administrador (1): sin instancias en /users → null; addUser restringe sys_perm/sysapp_user_perm a sysapp tipo 1.
      // Editor (13): [] = no asignar instancias ni permisos de instancia por defecto (antes null asignaba todas).
      selectedInstanceIds = Number(tipo) === 1 ? null : [];
    }

    const userCurp = await usersModelMain.findOne({ where: { curp: curp } });
    const userCorreo = await usersModelMain.findOne({ where: { email: correo } });

    if (userCurp && userCorreo && Number(userCurp.id_user) !== Number(userCorreo.id_user)) {
      return res.json({ success: false, msg: 'CURP y correo pertenecen a usuarios distintos.' });
    }
    if (!userCurp && userCorreo) {
      return res.json({ success: false, msg: 'Error, correo ya utilizado' });
    }

    /** Usuario ya en sys_morena: no se modifica fk_id_cat_type_users; rol CMS + copia a sys_perm vía applyCmsRoleAccess. */
    if (userCurp) {
      const em = String(userCurp.email || '').trim().toLowerCase();
      const emIn = String(correo || '').trim().toLowerCase();
      if (em !== emIn) {
        return res.json({
          success: false,
          msg: 'El correo no coincide con el registrado para esta CURP.',
        });
      }
      const activeCms = await usersModelMain.getActiveCmsRoleAssignment(userCurp.id_user);
      if (activeCms) {
        return res.json({
          success: false,
          msg: 'El usuario ya está registrado en el este sistema, no se puede registrar nuevamente.',
        });
      }
      const cmsRolId = await usersModelMain.resolveCmsRoleIdByCatTypeUsers(tipo);
      if (cmsRolId == null) {
        return res.json({
          success: false,
          msg:
            'No hay rol CMS para el tipo seleccionado. Configura cat_roles_sysapp (rol y/o mapeo de tipo) para este tipo.',
        });
      }
      try {
        await usersModelMain.applyCmsRoleAccess(userCurp.id_user, cmsRolId, {});
      } catch (e) {
        console.error('[addUserNoAd] applyCmsRoleAccess', e);
        return res.json({
          success: false,
          msg: e.message || 'No se pudieron asignar permisos del CMS.',
        });
      }
      if (scope === 'instance') {
        await assignUserToInstances(userCurp.id_user, selectedInstanceIds, req.usdata.id_user, {
          copyCreatorSysPerm: false,
        });
      }
      const fullName = [userCurp.nombre, userCurp.primer_apellido, userCurp.segundo_apellido]
        .filter(Boolean)
        .join(' ');
      const resultadoCorreo =
        scope === 'instance'
          ? await sendInstanceAssignmentEmail({
              to: userCurp.email || correo,
              toName: fullName || nombre,
              instanceIds: selectedInstanceIds || [],
              includeCredentials: false,
            })
          : await sendNewUserWelcomeEmail({
              to: userCurp.email || correo,
              toName: fullName || nombre,
              includeCredentials: false,
            });
      if (resultadoCorreo?.skipped || envioCorreoExitoso(resultadoCorreo)) {
        dispararBitacoraAltaUsuarioCms(req, {
          tipo,
          scope,
          selectedInstanceIds,
          idUsuarioAfectado: userCurp.id_user,
        });
        return res.json({
          success: true,
          msg:
            scope === 'instance'
              ? 'Usuario existente asignado a la(s) instancia(s) y notificado.'
              : 'Permisos del CMS actualizados y notificación enviada.',
        });
      }
      dispararBitacoraAltaUsuarioCms(req, {
        tipo,
        scope,
        selectedInstanceIds,
        idUsuarioAfectado: userCurp.id_user,
      });
      return res.json({
        success: true,
        msg:
          'Cambios guardados. No se pudo enviar el correo. ' + detalleFalloCorreo(resultadoCorreo, null),
      });
    }

    const passtemp = genCode();
    const saltRounds = 10;
    const salt = bcrypt.genSaltSync(saltRounds);
    const passws = passtemp;
    const hashedPass = bcrypt.hashSync(passws, salt);

    let resultAdmin = await usersModelMain.addUser({
      tipo: tipo,
      nombre: nombre,
      primer_apellido: primer_apellido,
      segundo_apellido: segundo_apellido,
      uname: correo,
      email: correo,
      telefono_fijo: telefono_fijo,
      telefono_celular: telefono_celular,
      hashedPass: hashedPass,
      curp: curp,
      fk_id_estado: fk_id_estado,
      instanceIds: selectedInstanceIds,
      skipInitialSysPerm: scope === 'instance',
      asignadorUserId: scope === 'instance' ? req.usdata.id_user : null,
    });

    if (resultAdmin) {
      const selectedIds = Array.isArray(selectedInstanceIds) ? selectedInstanceIds : [];
      const resultadoCorreo =
        selectedIds.length > 0
          ? await sendInstanceAssignmentEmail({
              to: correo,
              toName: nombre,
              instanceIds: selectedIds,
              includeCredentials: true,
              tempPassword: passws,
            })
          : await sendNewUserWelcomeEmail({
              to: correo,
              toName: nombre,
              includeCredentials: true,
              tempPassword: passws,
            });
      const nuevaFila = await userModel.findOne({
        where: { email: correo },
        attributes: ['id_user'],
        raw: true,
      });
      if (resultadoCorreo?.skipped || envioCorreoExitoso(resultadoCorreo)) {
        dispararBitacoraAltaUsuarioCms(req, {
          tipo,
          scope,
          selectedInstanceIds,
          idUsuarioAfectado: nuevaFila && nuevaFila.id_user,
        });
        return res.json({ success: true, msg: 'Usuario creado y notificado exitosamente' });
      }
      dispararBitacoraAltaUsuarioCms(req, {
        tipo,
        scope,
        selectedInstanceIds,
        idUsuarioAfectado: nuevaFila && nuevaFila.id_user,
      });
      return res.json({
        success: true,
        msg: 'Usuario creado correctamente. No se pudo enviar el correo. ' + detalleFalloCorreo(resultadoCorreo, null),
      });
    }
    res.status(200).json({ success: false, msg: 'Intente más tarde.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 1, message: 'Error' });
  }
}

async function adduserAD(req, res) {
  let id_user = req.usdata.id_user.toString();
  const curp = req.body.NuevoUsuarioCurpValidada.toString().trim();
  const correo = req.body.NuevoUsuarioCorreoConfirmar.toString().trim();
  const tipo = req.body.NuevoUsuarioTipo;
  const canInstance = hasArchivoAccess(req, '/users-instancia');
  const scope = resolveUsuariosScopeForAlta(req, canInstance);
  const allowedTypes = scope === 'instance' ? idsTipoUsuarioInstancia : idsTipoUsuarioRegistro;
  if (!allowedTypes.includes(Number(tipo))) {
    return res.json({ success: false, msg: 'Tipo de usuario no permitido' });
  }
  const nombre = req.body.NuevoUsuarioNombre;
  const primer_apellido = req.body.NuevoUsuarioPrimerA;
  const segundo_apellido = req.body.NuevoUsuarioSegundoA;
  try {
    let assignedInstances = [];
    if (scope === 'instance') {
      const validSet = await getValidInstanceSysappIdSet();
      assignedInstances = await getAssignedInstanceIdsIntersectValid(req.usdata.id_user, validSet);
    }
    let selectedInstanceIds = parseInstanceIdsFromBody(req.body);
    if (scope === 'instance') {
      if (!selectedInstanceIds.length) {
        return res.json({ success: false, msg: 'Selecciona al menos una instancia.' });
      }
      const invalidIds = selectedInstanceIds.filter((id) => !assignedInstances.includes(id));
      if (invalidIds.length) {
        return res.json({ success: false, msg: 'Instancias seleccionadas no válidas para este usuario.' });
      }
    } else if (selectedInstanceIds.length === 0) {
      // Misma regla que addUserNoAd: admin → null y addUser acota a sysapp tipo 1.
      selectedInstanceIds = Number(tipo) === 1 ? null : [];
    }

    const userCurp = await usersModelMain.findOne({ where: { curp: curp } });
    const userCorreo = await usersModelMain.findOne({ where: { email: correo } });

    if (userCurp && userCorreo && Number(userCurp.id_user) !== Number(userCorreo.id_user)) {
      return res.json({ success: false, msg: 'CURP y correo pertenecen a usuarios distintos.' });
    }
    if (!userCurp && userCorreo) {
      return res.json({ success: false, msg: 'Error, correo ya utilizado' });
    }

    if (userCurp) {
      const em = String(userCurp.email || '').trim().toLowerCase();
      const emIn = String(correo || '').trim().toLowerCase();
      if (em !== emIn) {
        return res.json({
          success: false,
          msg: 'El correo no coincide con el registrado para esta CURP.',
        });
      }
      const activeCms = await usersModelMain.getActiveCmsRoleAssignment(userCurp.id_user);
      if (activeCms) {
        return res.json({
          success: false,
          msg: 'El usuario ya está registrado en el CMS.',
        });
      }
      const cmsRolId = await usersModelMain.resolveCmsRoleIdByCatTypeUsers(tipo);
      if (cmsRolId == null) {
        return res.json({
          success: false,
          msg:
            'No hay rol CMS para el tipo seleccionado. Configura cat_roles_sysapp (rol y/o mapeo de tipo) para este tipo.',
        });
      }
      try {
        await usersModelMain.applyCmsRoleAccess(userCurp.id_user, cmsRolId, {});
      } catch (e) {
        console.error('[adduserAD] applyCmsRoleAccess', e);
        return res.json({
          success: false,
          msg: e.message || 'No se pudieron asignar permisos del CMS.',
        });
      }
      if (scope === 'instance') {
        await assignUserToInstances(userCurp.id_user, selectedInstanceIds, req.usdata.id_user, {
          copyCreatorSysPerm: false,
        });
      }
      const fullName = [userCurp.nombre, userCurp.primer_apellido, userCurp.segundo_apellido]
        .filter(Boolean)
        .join(' ');
      const resultadoCorreo =
        scope === 'instance'
          ? await sendInstanceAssignmentEmail({
              to: userCurp.email || correo,
              toName: fullName || nombre,
              instanceIds: selectedInstanceIds || [],
              includeCredentials: false,
            })
          : await sendNewUserWelcomeEmail({
              to: userCurp.email || correo,
              toName: fullName || nombre,
              includeCredentials: false,
            });
      if (resultadoCorreo?.skipped || envioCorreoExitoso(resultadoCorreo)) {
        dispararBitacoraAltaUsuarioCms(req, {
          tipo,
          scope,
          selectedInstanceIds,
          idUsuarioAfectado: userCurp.id_user,
        });
        return res.json({
          success: true,
          msg:
            scope === 'instance'
              ? 'Usuario existente asignado a la(s) instancia(s) y notificado.'
              : 'Permisos del CMS actualizados y notificación enviada.',
        });
      }
      dispararBitacoraAltaUsuarioCms(req, {
        tipo,
        scope,
        selectedInstanceIds,
        idUsuarioAfectado: userCurp.id_user,
      });
      return res.json({
        success: true,
        msg:
          'Cambios guardados. No se pudo enviar el correo. ' + detalleFalloCorreo(resultadoCorreo, null),
      });
    }

    let resultAdmin = await usersModelMain.addUser({
      tipo: tipo,
      nombre: nombre,
      primer_apellido: primer_apellido,
      segundo_apellido: segundo_apellido,
      uname: correo,
      email: correo,
      telefono_fijo: '',
      telefono_celular: '',
      hashedPass: '',
      curp: curp,
      fk_id_estado: null,
      instanceIds: selectedInstanceIds,
      skipInitialSysPerm: scope === 'instance',
      asignadorUserId: scope === 'instance' ? req.usdata.id_user : null,
    });

    if (resultAdmin) {
      const selectedIds = Array.isArray(selectedInstanceIds) ? selectedInstanceIds : [];
      const resultadoCorreo =
        selectedIds.length > 0
          ? await sendInstanceAssignmentEmail({
              to: correo,
              toName: nombre,
              instanceIds: selectedIds,
              includeCredentials: false,
            })
          : await sendNewUserWelcomeEmail({
              to: correo,
              toName: nombre,
              includeCredentials: false,
            });
      const nuevaFilaAd = await userModel.findOne({
        where: { email: correo },
        attributes: ['id_user'],
        raw: true,
      });
      if (resultadoCorreo?.skipped || envioCorreoExitoso(resultadoCorreo)) {
        dispararBitacoraAltaUsuarioCms(req, {
          tipo,
          scope,
          selectedInstanceIds,
          idUsuarioAfectado: nuevaFilaAd && nuevaFilaAd.id_user,
        });
        return res.json({ success: true, msg: 'Usuario creado y notificado exitosamente' });
      }
      dispararBitacoraAltaUsuarioCms(req, {
        tipo,
        scope,
        selectedInstanceIds,
        idUsuarioAfectado: nuevaFilaAd && nuevaFilaAd.id_user,
      });
      return res.json({
        success: true,
        msg: 'Usuario creado correctamente. No se pudo enviar el correo. ' + detalleFalloCorreo(resultadoCorreo, null),
      });
    }
    res.status(200).json({ success: false, msg: 'Intente más tarde.' });
    /*let userCurp = await userAdminModel.findOne({curp: req.body.NuevoUsuarioCurpValidada});
    let userCorreo = await userAdminModel.findOne({correo: req.body.NuevoUsuarioCorreoConfirmar});
    if(!userCurp && !userCorreo){
        const passtemp = genCode();
        const saltRounds = 10;
        const salt = bcrypt.genSaltSync(saltRounds);
        const passws = passtemp;
        const hashedPass = bcrypt.hashSync(passws, salt);
        //console.log(hashedPass);
        const newAdmin = new userAdminModel({
            nombre          :   req.body.NuevoUsuarioNombre,
            paterno         :   req.body.NuevoUsuarioPrimerA,
            materno         :   req.body.NuevoUsuarioSegundoA,
            curp            :   req.body,
            correo          :   req.body.NuevoUsuarioCorreoConfirmar,
            telefono        :   req.body.NuevoUsuarioTelefonoConfirmar,
            user            :   req.body.NuevoUsuarioCorreoConfirmar,
            pass            :   hashedPass,
            fk_id_tipo_user :   req.body.NuevoUsuarioTipo
        });
      
        const resultAdmin = await newAdmin.save();
        if(resultAdmin){
            res.json({ success: true, msg: 'Guardado'});
        } else{
            res.json({ success: false, msg: 'Error al guardar'});
        }
    } else if(userCurp){
        res.json({ success: false, msg: 'Error, CURP ya utilizada'});
    }else if(userCorreo){
        res.json({ success: false, msg: 'Error, correo ya utilizado'});
    } else {
        res.json({ success: false, msg: 'Error'});
    }*/
  } catch (error) {
    // await  registroBitacoraControl(id_user,'Administrador',req.body.NuevoUsuarioCurpValidada,500,'usuariosController.adduser  ::' + error.message);
    console.error('--->>> usuariosController.adduser ');
    console.error(error);
    res.status(500).json({ success: false, error: 1, message: 'Error' });
  }

  /*let userCurp = await userAdminModel.findOne({curp: req.body.NuevoUsuarioCurpValidada});
    let userCorreo = await userAdminModel.findOne({correo: req.body.NuevoUsuarioCorreoConfirmar});
    if(!userCurp && !userCorreo){
        const passtemp = genCode();
        const saltRounds = 10;
        const salt = bcrypt.genSaltSync(saltRounds);
        const passws = passtemp;
        const hashedPass = bcrypt.hashSync(passws, salt);
        //console.log(hashedPass);
        const newAdmin = new userAdminModel({
            nombre          :   req.body.NuevoUsuarioNombre,
            paterno         :   req.body.NuevoUsuarioPrimerA,
            materno         :   req.body.NuevoUsuarioSegundoA,
            curp            :   req.body,
            correo          :   req.body.NuevoUsuarioCorreoConfirmar,
            telefono        :   req.body.NuevoUsuarioTelefonoConfirmar,
            user            :   req.body.NuevoUsuarioCorreoConfirmar,
            pass            :   hashedPass,
            fk_id_tipo_user :   req.body.NuevoUsuarioTipo
        });
      
        const resultAdmin = await newAdmin.save();
        if(resultAdmin){
            res.json({ success: true, msg: 'Guardado'});
        } else{
            res.json({ success: false, msg: 'Error al guardar'});
        }
    } else if(userCurp){
        res.json({ success: false, msg: 'Error, CURP ya utilizada'});
    }else if(userCorreo){
        res.json({ success: false, msg: 'Error, correo ya utilizado'});
    } else {
        res.json({ success: false, msg: 'Error'});
    }*/
}

async function NuevoUsuarioValidarCurp(req, res) {
  try {
    const curpRaw = String(req.body.curp || '')
      .trim()
      .toUpperCase();
    const curpRegex = /^[A-Z]{4}[0-9]{6}[A-Z]{6}[A-Z0-9][0-9][A-Z0-9]{0,2}$/;
    if (!curpRaw || !curpRegex.test(curpRaw)) {
      return res.json({ success: false, msg: 'Formato de CURP inválido' });
    }

    const existing = await usersModelMain.findOne({ where: { curp: curpRaw } });
    if (existing) {
      const row = existing.dataValues || existing;
      return res.json({
        success: true,
        msg: 'Usuario encontrado en el sistema. Los datos se completarán desde el registro existente.',
        existingUser: true,
        data: {
          curp: row.curp,
          nombre: row.nombre,
          primerA: row.primer_apellido,
          segundoA: row.segundo_apellido,
          correo: row.email,
        },
      });
    }

    if (process.env.RENAPO_ACTIVE === 'true') {
      const consultaCurp = await renapoConsultarCurp(curpRaw);
      if (consultaCurp) {
        return res.json({
          success: true,
          msg: 'CURP válida (RENAPO)',
          existingUser: false,
          data: {
            curp: consultaCurp.curpResponse,
            primerA: consultaCurp.primerA,
            segundoA: consultaCurp.segundoA,
            nombre: consultaCurp.nombre,
          },
        });
      }
      return res.json({ success: false, msg: 'CURP NO ENCONTRADO EN RENAPO' });
    }

    return res.json({
      success: true,
      msg: 'Puede continuar llenando el formulario.',
      existingUser: false,
      data: { curp: curpRaw },
    });
  } catch (e) {
    console.error('[NuevoUsuarioValidarCurp]', e);
    return res.status(500).json({ success: false, msg: 'Error al validar CURP' });
  }
}

async function getUsers(req, res) {}

async function obtenerPermisosUser(req, res) {
  const id_user = req.body.id_user;

  const usuario = await userModel.findOne({ where: { id_user: id_user } });
  // console.log(usuario);
  if (!usuario) return; //No deberian poderse intentar con curp de no usuarios.
  res.json({
    success: true,
    data: {
      tipo: usuario.fk_id_cat_type_users,
      nombre: usuario.nombre,
      usuario: usuario.uname,
      primerA: usuario.primer_apellido,
      segundoA: usuario.segundo_apellido,
      curp: usuario.curp,
      correo: usuario.email,
      telefonoFijo: usuario.telefono_fijo,
      telefonoCelular: usuario.telefono_celular,
      entidad: usuario.fk_id_estado,
    },
  });
}
async function obtenerAdminView(req, res) {
  try {
    const id_user = parseInt(req.body.id_user, 10);
    const id_type = parseInt(req.body.id_type, 10);
    if (!Number.isFinite(id_user) || !Number.isFinite(id_type)) {
      return res.json({
        success: false,
        msg: 'Seleccione el tipo de usuario en el modal o vuelva a abrir la ventana.',
      });
    }

    const modulos_pre = await CatalogModel.getAdminView(id_user, id_type);

  // console.log(util.inspect(modulos_pre, { showHidden: false, depth: null, colors: true }));

  let arr_modulos = {};

  for (let i = 0; i < modulos_pre.length; i++) {
    const sysappId = modulos_pre[i].id_sysapp;
    const sysmodId = modulos_pre[i].id_sysmod;
    const syssubmodId = modulos_pre[i].id_syssubmod;

    // Crear el objeto de la aplicación si no existe
    if (!arr_modulos[sysappId]) {
      arr_modulos[sysappId] = {
        app_name: modulos_pre[i].app_legend,
        id: sysappId,
        mod_count: 0,
        modulos: {} // Cambiar a un objeto
      };
    }

    // Crear el módulo si no existe
    if (!arr_modulos[sysappId].modulos[sysmodId]) {
      arr_modulos[sysappId].mod_count++;
      arr_modulos[sysappId].modulos[sysmodId] = {
        id_mod: sysmodId,
        mod_legend: modulos_pre[i].modulo_legend,
        micon: modulos_pre[i].micon,
        submod_count: 0,
        submodulos: {}
      };
    }

    // Crear el submódulo si no existe
    if (!arr_modulos[sysappId].modulos[sysmodId].submodulos[syssubmodId]) {
      arr_modulos[sysappId].modulos[sysmodId].submod_count++;
      arr_modulos[sysappId].modulos[sysmodId].submodulos[syssubmodId] = {
        id_syssubmod: syssubmodId,
        legend: modulos_pre[i].submodulo_legend,
        archivo: modulos_pre[i].archivo,
        smicon: modulos_pre[i].smicon,
        perm_type: modulos_pre[i].perm_type,
        perm_user: modulos_pre[i].perm_user
      };
    }
  }

  for (const k of Object.keys(arr_modulos)) {
    arr_modulos[k] = dedupeModulosMismaLeyenda(arr_modulos[k]);
  }

  Object.values(arr_modulos).forEach(app => {
    if(app.mod_count===1) {
      Object.values(app.modulos).forEach(modulo => {
        if(modulo.submod_count===1) {
          Object.values(modulo.submodulos).forEach( submod=> {
            if (isUsersInstanciaSubmod(submod)) return;
            arr_modulos[app.id].legend=submod.legend;
            arr_modulos[app.id].archivo=submod.archivo;
            arr_modulos[app.id].smicon=submod.smicon;
            arr_modulos[app.id].id_syssubmod=submod.id_syssubmod;
            arr_modulos[app.id].perm_type=submod.perm_type;
            arr_modulos[app.id].perm_user=submod.perm_user;
          })
        }
      })
    } else {
      Object.values(app.modulos).forEach(modulo => {
        if(modulo.submod_count===1) {
          Object.values(modulo.submodulos).forEach( submod=> {
            if (isUsersInstanciaSubmod(submod)) return;
            arr_modulos[app.id].modulos[modulo.id_mod].legend=submod.legend;
            arr_modulos[app.id].modulos[modulo.id_mod].archivo=submod.archivo;
            arr_modulos[app.id].modulos[modulo.id_mod].smicon=submod.smicon;
            arr_modulos[app.id].modulos[modulo.id_mod].id_syssubmod=submod.id_syssubmod;
            arr_modulos[app.id].modulos[modulo.id_mod].perm_type=submod.perm_type;
            arr_modulos[app.id].modulos[modulo.id_mod].perm_user=submod.perm_user;

          })
        }
      })
    }
  });

  // console.log(util.inspect(arr_modulos, { showHidden: false, depth: null, colors: true }));

  res.json({
    success: true,
    data: arr_modulos,
  });
  } catch (e) {
    console.error('obtenerAdminView', e);
    return res.json({ success: false, msg: 'Error al cargar permisos' });
  }
}

async function editarPermisosUser(req, res) {
  try {
    console.log(req.body.id_user)
    console.log(req.body.correo)
    console.log(req.body.id_type)
    console.log(req.body.permisosSeleccionados)
    const idus = parseInt(req.body.id_user, 10);
    const correo = String(req.body?.correo || '').trim();
    const id_type = parseInt(String(req.body?.id_type || '').trim(), 10);
    if (!Number.isFinite(id_type) || !idsTipoUsuarioRegistro.includes(id_type)) {
      return res.json({ success: false, msg: 'Tipo de usuario no permitido' });
    }
    if (!Number.isFinite(idus)) {
      return res.json({ success: false, msg: 'Usuario inválido' });
    }
    const permisosUsuario = Array.isArray(req.body.permisosSeleccionados)
      ? req.body.permisosSeleccionados
      : [];
    const targetUser = await userModel.findOne({ where: { id_user: idus } });
    if (!targetUser) {
      return res.json({ success: false, msg: 'Usuario inválido' });
    }
    // Si el front no envía correo (o llega vacío), conservar el actual para no romper la edición de permisos.
    const correoActual = String(targetUser.email || '').trim();
    const correoFinal = correo || correoActual;

    let userCorreo = null;
    if (emailFueAlteradoEnFormulario(correo, correoActual) && correoFinal) {
      userCorreo = await userModel.findOne({
        where: { email: { [Op.iLike]: correoFinal }, id_user: { [Op.ne]: idus } },
      });
    }

    if (!userCorreo) {
      if(permisosUsuario.length>0){

        const targetMain = await usersModelMain.findOne({ where: { id_user: idus } });
        if (!targetMain) {
          return res.json({ success: false, msg: 'Usuario no válido.' });
        }
        const currentCatType = getCatTypeUsersIdFromRow(targetMain);
        const preserveUserType = shouldPreserveFkCatTypeUsersOnSuperAdminSave(currentCatType, id_type);

        let resultUpdate = await usersModelMain.updateUser({
          id_user: idus,
          email: correoFinal,
          id_type: id_type,
          permisos: permisosUsuario,
          preserveUserType,
        });

        if (!resultUpdate) {
          return res.json({ success: false, msg: 'No se pudo guardar los cambios.' });
        }
        console.log('Usuarios actualizados');
        res.json({ success: true });
      } else {
        res.json({ success: false, msg: 'Favor de elegir un modulo' });
      }
    } else {
      res.json({ success: false, msg: 'El correo ya está en uso con otro usuario' });
    }
  } catch (e) {
    console.error('--->>> usuariosController.editarPermisosUser ');
    console.error(e.message);
    res.json({ success: false, msg: 'Error' });
  }
}

async function deActiveUser(req, res) {
  try {
    const id = parseInt(req.body.id, 10);
    if (!Number.isFinite(id)) {
      return res.json({ success: false, msg: 'Usuario inválido.' });
    }
    const target = await userModel.findOne({
      attributes: ['id_user', 'fk_id_cat_type_users'],
      where: { id_user: id },
    });
    if (!target) {
      return res.json({ success: false, msg: 'Usuario no encontrado.' });
    }
    const catTypeRaw = target.getDataValue('fk_id_cat_type_users');
    const catType =
      catTypeRaw != null && catTypeRaw !== '' ? parseInt(String(catTypeRaw), 10) : NaN;
    const isEditor = idsTipoUsuarioInstancia.includes(catType);
    const grupo = parseInt(process.env.GRUPO_APLICACIONES, 10);
    const outsideCms =
      Number.isFinite(grupo) &&
      (await usersModelMain.userHasActiveSysPermOutsideGrupo(id, grupo));

    const okRevoke = await usersModelMain.revokeCmsAccessForUser(id);
    if (!okRevoke) {
      return res.json({ success: false, msg: 'No se pudo revocar el acceso al CMS.' });
    }

    /** Editor o con permisos fuera del grupo CMS: baja solo del CMS, no `users.activo`. */
    const preserveGlobalRow = isEditor || outsideCms;
    if (!preserveGlobalRow) {
      const [n] = await userModel.update({ activo: false }, { where: { id_user: id } });
      if (!n) {
        return res.json({ success: false, msg: 'No se pudo actualizar el usuario.' });
      }
    }

    const actor = req.usdata && req.usdata.id_user;
    if (actor) {
      void registraBitacora({
        fk_id_user_actor: actor,
        accion: BITACORA.USUARIO_CMS_BAJA,
        fk_id_user_afectado: id,
        detalle: {
          solo_revocacion_cms: preserveGlobalRow,
          fk_id_cat_type_users: Number.isFinite(catType) ? catType : null,
          permisos_fuera_grupo_cms: outsideCms,
        },
        req,
      });
    }

    res.json({
      success: true,
      msg: preserveGlobalRow
        ? 'Acceso al CMS revocado. El usuario permanece activo en el sistema (otro perfil u otras aplicaciones).'
        : 'Usuario desactivado.',
    });
  } catch (e) {
    console.error('--->>> usuariosController.deActiveUser ');
    console.error(e.message);
    res.json({ success: false, msg: 'Error' });
  }
}

async function reActiveUser(req, res) {
  try {
    const id = parseInt(req.body.id, 10);
    if (!Number.isFinite(id)) {
      return res.json({ success: false, msg: 'Usuario inválido.' });
    }
    const [n] = await userModel.update({ activo: true }, { where: { id_user: id } });
    if (!n) {
      return res.json({ success: false, msg: 'Usuario no encontrado.' });
    }
    await usersModelMain.reactivateCmsAccessForUser(id);
    res.json({ success: true, msg: 'Usuario reactivado.' });
  } catch (e) {
    console.error('--->>> usuariosController.reActiveUser ');
    console.error(e.message);
    res.json({ success: false, msg: 'Error' });
  }
}

async function actualizarContrasenaUser(req, res) {
  let id_user = req.usdata.id_user.toString();
  try {
    const id = req.body.id;
    console.log('id de usuario a actualizar: '+id)

    const data = await userModel.findOne({ where: { id_user: id } });

    if (data) {
      const passtemp = genCode();

      const saltRounds = 10;
      const salt = bcrypt.genSaltSync(saltRounds);
      const passws = passtemp;
      const hashedPass = bcrypt.hashSync(passws, salt);
      const correo = data.email;
      const nombre = data.nombre;
      const resultUpdate = await userModel.update(
          { upass: hashedPass, campass: false },
          { where: { id_user: id } } // Aquí debes especificar el id del usuario que deseas actualizar
      );
      console.log(resultUpdate)
      console.log('📧 MAIL_ACTIVE (actualizar contraseña):', process.env.MAIL_ACTIVE);
      if (resultUpdate && process.env.MAIL_ACTIVE == 'true') {
        // await  registroBitacoraControl(id_user,'Administrador',req.body.NuevoUsuarioCurpValidada,5,'');
        const appBaseUrl = process.env.APP_BASE_URL != '' ? process.env.APP_BASE_URL : 'morena.org';
        const imagePathTop = path.join(
            __dirname,
            '../public/assets/avisos/FIRMA_CORREO_MORENA_2.png'
        );
        const imagePathBottom = path.join(
            __dirname,
            '../public/assets/avisos/FIRMA_CORREO_MORENA_1.jpg'
        );

        const body = `<html>
                        <body style="margin:0; padding:0; text-align:center;">
                            <div style="max-width:800px; margin:0 auto; text-align:center;">
                                <img src="cid:topImage" style="width:100%; max-width:800px; display:block;">
                                <div style="max-width:600px; margin:0 auto; padding:30px 20px; font-family:Montserrat, Arial, sans-serif; color:#021B23; text-align:center;">
                                    <h2 style="font-weight:800; color:#235b4e; margin:20px 0; font-size:1.8rem;">DATOS DE ACCESO AL SISTEMA DE ADMINISTRACIÓN DE CONTENIDO INSTITUCIONAL</h2>
                                    <hr style="border:none; height:3px; width:120px; background-color:#B38E5D; margin:10px auto 25px auto;">
                                    
                                    <p style="color:#333; font-size:15px; text-align:center; line-height:1.6; margin:25px 0;">Sus datos de inicio de sesión son los siguientes:</p>
                                    
                                    <div style="background-color:#f5f5f5; border:2px solid #B38E5D; border-radius:8px; padding:20px; margin:25px auto; max-width:450px;">
                                        <p style="margin:10px 0; font-weight:700; font-size:1rem; color:#235b4e;">USUARIO:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${correo}</p>
                                        <p style="margin:15px 0 10px 0; font-weight:700; font-size:1rem; color:#235b4e;">CONTRASEÑA TEMPORAL:</p>
                                        <p style="margin:5px 0; font-size:1.3rem; font-weight:800; color:#8b1e1e;">${passtemp}</p>
                                    </div>
                                    
                                    <p style="margin:25px 0; font-size:15px; color:#333; text-align:center;">Esta contraseña fue generada automáticamente desde el sistema de gestión de MORENA.</p>
                                    <p style="margin:20px 0; font-size:15px; color:#333; text-align:center;">Puedes ingresar al sistema desde el siguiente enlace:</p>
                                    <p style="margin:20px 0; text-align:center;">
                                        <a href="https://${appBaseUrl}/" style="color:#8b1e1e; font-weight:700; text-decoration:none; font-size:16px;">https://${appBaseUrl}/</a>
                                    </p>
                                </div>
                                <img src="cid:bottomImage" style="width:100%; max-width:800px; display:block;">
                            </div>
                        </body>
                    </html>`;

        const asunto = 'DATOS DE ACCESO';

        try {
          const resultado = await enviarEmail({
            to: correo,
            to_name: nombre,
            subject: asunto,
            body: body,
            isHTml: true,
            attachments: [
              {
                path: imagePathTop,
                filename: 'FIRMA_CORREO_MORENA_2.png',
                type: 'image/png',
                disposition: 'inline',
                cid: 'topImage',
              },
              {
                path: imagePathBottom,
                filename: 'FIRMA_CORREO_MORENA_1.jpg',
                type: 'image/jpeg',
                disposition: 'inline',
                cid: 'bottomImage',
              },
            ],
          });
          console.log('Resultado envío correo actualización:', resultado);
          if (envioCorreoExitoso(resultado)) {
            return res.json({
              success: true,
              msg: 'Contraseña actualizada y Correo Enviado exitosamente',
            });
          }
          console.error('Fallo al enviar correo actualización:', resultado?.msg || resultado?.error);
          return res.json({
            success: true,
            msg:
              'Contraseña actualizada correctamente. No se pudo enviar el correo. ' +
              detalleFalloCorreo(resultado, null),
          });
        } catch (error) {
          console.error('Error en envío de correo actualización:', error);
          return res.json({
            success: true,
            msg:
              'Contraseña actualizada correctamente. No se pudo enviar el correo. ' +
              detalleFalloCorreo(null, error),
          });
        }
        // sgMail
        //     .send(msg)
        //     .then(() => {

        //         console.log('Correo enviado con éxito');

        //         return res.json({
        //             success: true,
        //             msg: 'Contraseña actualizada y Correo Enviado exitosamente'
        //         });

        //     })
        //     .catch((error) => {
        //         session.abortTransaction();
        //         session.endSession();
        //         console.error(error);
        //         return res.status(200).json({ success: false, msg: 'Intente mas tarde.' });
        //     });
      } else if (resultUpdate) {
        res.status(200).json({ success: true, msg: 'Contraseña actualizada: '+passtemp });

      }else {
        res.status(200).json({ success: false, msg: 'Intente más tarde.' });
      }
    } else {
      return res
          .status(200)
          .json({ success: false, msg: 'CURP no encontrado.' });
    }
  } catch (e) {
    // await  registroBitacoraControl(id_user,'Administrador',req.body.NuevoUsuarioCurpValidada,500,'usuariosController.actualizarContrasenaUser  ::' + error.message);
    console.error('--->>> usuariosController.actualizarContrasenaUser ');
    console.error(e.message);
    res.json({ success: false, msg: 'Error' });
  }
}

/** Convierte legado { "94": [1,2,5] } y pageId único a pageIds */
function normalizePaginaScopeFromBody(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (Array.isArray(v)) {
      out[k] = {};
      v.forEach((t) => {
        const n = parseInt(t, 10);
        if (Number.isFinite(n)) out[k][String(n)] = { all: true };
      });
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = {};
      for (const [ts, spec] of Object.entries(v)) {
        const tipoNum = parseInt(ts, 10);
        if (tipoNum === TIPO_ENTRADA || tipoNum === TIPO_REGENERACION) {
          out[k][ts] = { all: true };
        } else if (spec && typeof spec === 'object' && spec.all === false && spec.pageIds == null && spec.pageId != null) {
          const p = parseInt(spec.pageId, 10);
          out[k][ts] = Number.isFinite(p) ? { all: false, pageIds: [p] } : spec;
        } else {
          out[k][ts] = spec;
        }
      }
    }
  }
  return out;
}

async function validatePaginaAlcancePayload(paginaScopeNorm, appsConPaginas) {
  const apps = Array.from(appsConPaginas);
  for (const appId of apps) {
    const key = String(appId);
    console.log(key);
    const scopeForApp = paginaScopeNorm[key];
    if (!scopeForApp || typeof scopeForApp !== 'object' || Array.isArray(scopeForApp)) {
      return {
        ok: false,
        msg:
          'Tienes activado el submódulo Páginas pero no marcaste ningún tipo de alcance. En el acordeón «Alcance de páginas», activa al menos uno: página principal, páginas interiores, entradas o regeneración.',
      };
    }
    const tiposConAlcance = Object.keys(scopeForApp)
      .map((x) => parseInt(x, 10))
      .filter((n) =>
        [TIPO_PRINCIPAL, TIPO_INTERIOR, TIPO_ENTRADA, TIPO_REGENERACION].includes(n)
      );
    if (!tiposConAlcance.length) {
      return {
        ok: false,
        msg:
          'Para el módulo Páginas debes indicar al menos un alcance: principal, interiores, entradas o regeneración.',
      };
    }
    for (const [tipoStr, spec] of Object.entries(scopeForApp)) {
      const tipo = parseInt(tipoStr, 10);
      if (![TIPO_PRINCIPAL, TIPO_INTERIOR, TIPO_ENTRADA, TIPO_REGENERACION].includes(tipo)) continue;
      const s = spec && typeof spec === 'object' ? spec : {};
      if (tipo === TIPO_ENTRADA) {
        if (s.all === false) {
          return {
            ok: false,
            msg: 'Las entradas solo permiten acceso a todas; no se pueden restringir entradas individuales.',
          };
        }
        continue;
      }
      if (tipo === TIPO_REGENERACION) {
        if (s.all === false) {
          return {
            ok: false,
            msg:
              'La sección Regeneración solo admite acceso completo; no se pueden listar documentos individuales en el alcance.',
          };
        }
        continue;
      }
      if (s.all === false) {
        const ids = [];
        if (Array.isArray(s.pageIds)) {
          for (const x of s.pageIds) {
            const p = parseInt(x, 10);
            if (Number.isFinite(p)) ids.push(p);
          }
        }
        if (!ids.length && s.pageId != null) {
          const p = parseInt(s.pageId, 10);
          if (Number.isFinite(p)) ids.push(p);
        }
        if (!ids.length) {
          return {
            ok: false,
            msg: 'Seleccione al menos una página en cada tipo de alcance marcado.',
          };
        }
        for (const pid of [...new Set(ids)]) {
          const row = await paginaModel.pagina.findOne({
            where: {
              id_wb_pagina: pid,
              fk_id_sysapp: appId,
              fk_id_cat_type_pagina: tipo,
              vigente: true,
            },
            raw: true,
          });
          if (!row) {
            return { ok: false, msg: 'Una de las páginas del alcance no es válida para la instancia.' };
          }
        }
      }
    }
  }
  return { ok: true };
}

async function grantorHasSysPerm(grantorId, syssubmodId, sysappId) {
  return CatalogModel.grantorHasSyssubmodPerm(grantorId, syssubmodId, sysappId);
}

/** Detecta submódulo de listado/edición de páginas (no usuarios-instancia). */
async function syssubmodIdsSonModuloPaginas(ids) {
  const clean = (Array.isArray(ids) ? ids : []).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  if (!clean.length) return new Set();
  const rows = await PGconn.query(
    `SELECT s.id_syssubmod, r.archivo
     FROM syssubmod s
     LEFT JOIN rutas r ON r.id_ruta = s.fk_id_ruta
     WHERE s.id_syssubmod = ANY($1::int[])`,
    { bind: [clean], type: QueryTypes.SELECT }
  );
  const out = new Set();
  const norm = (a) =>
    String(a || '')
      .trim()
      .toLowerCase()
      .replace(/^\//, '')
      .replace(/_/g, '-')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  for (const row of rows || []) {
    const a = norm(row.archivo);
    if (a.includes('paginas') && !a.includes('users-instancia')) {
      out.add(parseInt(row.id_syssubmod, 10));
    }
  }
  return out;
}

async function obtenerPermisosUserInstance(req, res) {
  return obtenerPermisosUser(req, res);
}

/** Normaliza `rutas.archivo` como en SQL de catálogo (usuarios instancia). */
function normRutaArchivoParaFiltroInstancia(archivo) {
  return String(archivo || '')
    .trim()
    .toLowerCase()
    .replace(/^\//, '')
    .replace(/_/g, '-')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** No listar «Administrador de usuarios» (/users) al asignar permisos por instancia (solo /users-instancia). */
function isExcludedSuperUsersSubmodFromInstancePermMatrix(row) {
  if (!row) return false;
  const a = normRutaArchivoParaFiltroInstancia(row.archivo);
  if (a === 'users' || a.startsWith('users/')) return true;
  const normTxt = (t) =>
    String(t || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  const sub = normTxt(row.submodulo_legend);
  const mod = normTxt(row.modulo_legend);
  if (sub.includes('administrador de usuarios') || mod.includes('administrador de usuarios')) return true;
  if (sub.includes('administrador') && sub.includes('usuarios') && !sub.includes('instancia')) return true;
  if (mod.includes('administrador') && mod.includes('usuarios') && !mod.includes('instancia')) return true;
  return false;
}

async function obtenerAdminViewInstance(req, res) {
  try {
    const id_user = parseInt(req.body.id_user, 10);
    const id_type = parseInt(req.body.id_type, 10);
    if (!Number.isFinite(id_user) || !Number.isFinite(id_type)) {
      return res.json({ success: false, msg: 'Parámetros inválidos' });
    }
    if (id_type !== 13) {
      return res.json({ success: false, msg: 'Solo se admite tipo Editor en usuarios de instancia.' });
    }
    const grantor = req.usdata.id_user;
    const validSet = await getValidInstanceSysappIdSet();
    const grantorInst = await getAssignedInstanceIdsIntersectValid(grantor, validSet);
    if (!grantorInst.length) {
      return res.json({ success: false, msg: 'No tiene instancias asignadas para administrar permisos.' });
    }

    let modulos_pre = await CatalogModel.getAdminViewForGrantor(grantor, id_user, id_type, grantorInst);
    modulos_pre = (modulos_pre || []).filter((row) => !isExcludedSuperUsersSubmodFromInstancePermMatrix(row));

    const arr_modulos = {};
    for (let i = 0; i < modulos_pre.length; i++) {
      const sysappId = modulos_pre[i].id_sysapp;
      const sysmodId = modulos_pre[i].id_sysmod;
      const syssubmodId = modulos_pre[i].id_syssubmod;

      if (!arr_modulos[sysappId]) {
        arr_modulos[sysappId] = {
          app_name: modulos_pre[i].app_legend,
          id: sysappId,
          mod_count: 0,
          modulos: {},
        };
      }

      if (!arr_modulos[sysappId].modulos[sysmodId]) {
        arr_modulos[sysappId].mod_count++;
        arr_modulos[sysappId].modulos[sysmodId] = {
          id_mod: sysmodId,
          mod_legend: modulos_pre[i].modulo_legend,
          micon: modulos_pre[i].micon,
          submod_count: 0,
          submodulos: {},
        };
      }

      if (!arr_modulos[sysappId].modulos[sysmodId].submodulos[syssubmodId]) {
        arr_modulos[sysappId].modulos[sysmodId].submod_count++;
        arr_modulos[sysappId].modulos[sysmodId].submodulos[syssubmodId] = {
          id_syssubmod: syssubmodId,
          legend: modulos_pre[i].submodulo_legend,
          archivo: modulos_pre[i].archivo,
          smicon: modulos_pre[i].smicon,
          perm_type: modulos_pre[i].perm_type,
          perm_user: modulos_pre[i].perm_user,
        };
      }
    }

    for (const k of Object.keys(arr_modulos)) {
      arr_modulos[k] = dedupeModulosMismaLeyenda(arr_modulos[k]);
    }

    Object.values(arr_modulos).forEach((app) => {
      if (app.mod_count === 1) {
        Object.values(app.modulos).forEach((modulo) => {
          if (modulo.submod_count === 1) {
            Object.values(modulo.submodulos).forEach((submod) => {
              if (isUsersInstanciaSubmod(submod)) return;
              arr_modulos[app.id].legend = submod.legend;
              arr_modulos[app.id].archivo = submod.archivo;
              arr_modulos[app.id].smicon = submod.smicon;
              arr_modulos[app.id].id_syssubmod = submod.id_syssubmod;
              arr_modulos[app.id].perm_type = submod.perm_type;
              arr_modulos[app.id].perm_user = submod.perm_user;
            });
          }
        });
      } else {
        Object.values(app.modulos).forEach((modulo) => {
          if (modulo.submod_count === 1) {
            Object.values(modulo.submodulos).forEach((submod) => {
              if (isUsersInstanciaSubmod(submod)) return;
              arr_modulos[app.id].modulos[modulo.id_mod].legend = submod.legend;
              arr_modulos[app.id].modulos[modulo.id_mod].archivo = submod.archivo;
              arr_modulos[app.id].modulos[modulo.id_mod].smicon = submod.smicon;
              arr_modulos[app.id].modulos[modulo.id_mod].id_syssubmod = submod.id_syssubmod;
              arr_modulos[app.id].modulos[modulo.id_mod].perm_type = submod.perm_type;
              arr_modulos[app.id].modulos[modulo.id_mod].perm_user = submod.perm_user;
            });
          }
        });
      }
    });

    res.json({ success: true, data: arr_modulos });
  } catch (e) {
    console.error('obtenerAdminViewInstance', e);
    res.json({ success: false, msg: 'Error al cargar permisos' });
  }
}

async function opcionesPaginasAlcanceInstancia(req, res) {
  try {
    const sysappId = parseInt(req.body.fk_id_sysapp ?? req.body.sysapp_id, 10);
    if (!Number.isFinite(sysappId)) {
      return res.json({ success: false, msg: 'Instancia inválida' });
    }
    const validSet = await getValidInstanceSysappIdSet();
    const allowed = await getAssignedInstanceIdsIntersectValid(req.usdata.id_user, validSet);
    if (!allowed.includes(sysappId)) {
      return res.json({ success: false, msg: 'Sin permiso para esta instancia.' });
    }
    const rows = await paginaModel.pagina.findAll({
      where: {
        fk_id_sysapp: sysappId,
        fk_id_cat_type_pagina: [TIPO_PRINCIPAL, TIPO_INTERIOR, TIPO_ENTRADA],
        vigente: true,
        // Igual que paginasList: no listar filas que son borrador (fk_pag_nueva), para no duplicar origen + borrador.
        [Op.and]: Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM rel_wb_pag_borrador b
            WHERE b.fk_pag_nueva = "wb_pagina".id_wb_pagina
            AND b.fk_id_cat_pag_tipo_borrador = 1
            AND b.vigente = true
          )
        `),
      },
      attributes: ['id_wb_pagina', 'nombre_pagina', 'fk_id_cat_type_pagina', 'url_safe'],
      order: [['nombre_pagina', 'ASC']],
      raw: true,
    });
    const data = { '1': [], '2': [], '5': [], '6': [] };
    const seenByTipo = { 1: new Set(), 2: new Set(), 5: new Set() };
    for (const r of rows || []) {
      const t = String(r.fk_id_cat_type_pagina);
      if (!data[t]) continue;
      const id = r.id_wb_pagina;
      if (seenByTipo[t].has(id)) continue;
      seenByTipo[t].add(id);
      data[t].push({
        id,
        nombre: r.nombre_pagina,
        url: r.url_safe,
      });
    }
    res.json({ success: true, data });
  } catch (e) {
    console.error('opcionesPaginasAlcanceInstancia', e);
    res.json({ success: false, msg: 'Error' });
  }
}

async function obtenerPaginaScopeUserInstance(req, res) {
  try {
    const id_user = parseInt(req.body.id_user, 10);
    if (!Number.isFinite(id_user)) {
      return res.json({ success: false, msg: 'Usuario inválido' });
    }
    const grantor = req.usdata.id_user;
    const validSet = await getValidInstanceSysappIdSet();
    const grantorInst = await getAssignedInstanceIdsIntersectValid(grantor, validSet);
    const allScopes = await usersModelMain.getPaginaScopesForUser(id_user);
    const filtered = {};
    for (const aid of grantorInst) {
      const k = String(aid);
      filtered[k] = allScopes[k] && typeof allScopes[k] === 'object' ? allScopes[k] : {};
    }
    res.json({ success: true, data: filtered, allowed_instances: grantorInst });
  } catch (e) {
    console.error('obtenerPaginaScopeUserInstance', e);
    res.json({ success: false, msg: 'Error' });
  }
}

async function editarPermisosUserInstance(req, res) {
  try {
    const idus = parseInt(req.body.id_user, 10);
    const correo = String(req.body.correo || '').trim();
    const id_type = parseInt(req.body.id_type, 10);
    const permisosUsuario = Array.isArray(req.body.permisosSeleccionados) ? req.body.permisosSeleccionados : [];
    const paginaScope = req.body.pagina_scope && typeof req.body.pagina_scope === 'object' ? req.body.pagina_scope : {};

    if (!Number.isFinite(idus) || id_type !== 13) {
      return res.json({ success: false, msg: 'Solo se permite editar usuarios tipo Editor.' });
    }

    const grantor = req.usdata.id_user;
    const validSet = await getValidInstanceSysappIdSet();
    const grantorInst = await getAssignedInstanceIdsIntersectValid(grantor, validSet);
    if (!grantorInst.length) {
      return res.json({ success: false, msg: 'No tiene instancias asignadas para administrar permisos.' });
    }

    const target = await userModel.findOne({ where: { id_user: idus } });
    if (!target) {
      return res.json({ success: false, msg: 'Usuario no válido.' });
    }
    // Mismo criterio que en editarPermisosUser: conservar email existente si el payload llega vacío.
    const correoActual = String(target.email || '').trim();
    const correoFinal = correo || correoActual;
    /**
     * Misma regla que el listado de usuarios instancia (`findEditorsByInstanceIdsForRegistrant`):
     * editor por rol CMS (nombre de rol), no necesariamente `fk_id_cat_type_users = 13` en `users`.
     * Antes solo se aceptaba tipo 13 en tabla users → "Usuario no válido" al guardar aun viendo al usuario en la lista.
     */
    const editoresAsignados = await usersModelMain.findEditorsByInstanceIdsForRegistrant(grantorInst, grantor);
    const permitidoPorLista = (editoresAsignados || []).some((r) => Number(r.id_user) === idus);
    if (!permitidoPorLista) {
      return res.json({ success: false, msg: 'Usuario no válido.' });
    }

    const grantorSet = new Set(grantorInst);

    const fromApps = new Set();
    for (const p of permisosUsuario) {
      const aid = parseInt(p.id_app, 10);
      if (Number.isFinite(aid)) fromApps.add(aid);
    }
    for (const k of Object.keys(paginaScope || {})) {
      const aid = parseInt(k, 10);
      if (Number.isFinite(aid)) fromApps.add(aid);
    }
    for (const aid of fromApps) {
      if (!grantorSet.has(aid)) {
        return res.json({ success: false, msg: 'Una de las instancias no está en su alcance.' });
      }
    }
    const allowedSysappIds = [...fromApps].sort((a, b) => a - b);

    let dup = null;
    if (emailFueAlteradoEnFormulario(correo, correoActual) && correoFinal) {
      dup = await userModel.findOne({
        where: { email: { [Op.iLike]: correoFinal }, id_user: { [Op.ne]: idus } },
      });
    }
    if (dup) {
      return res.json({ success: false, msg: 'El correo ya está en uso con otro usuario' });
    }

    if (!allowedSysappIds.length) {
      const okClear = await usersModelMain.updateUserInstance({
        id_user: idus,
        email: correoFinal,
        id_type: String(id_type),
        /** No sobrescribir `fk_id_cat_type_users`: usuarios existentes conservan su tipo; el editor en CMS va por `rel_user_sysapp_roles`. */
        preserveUserType: true,
        permisos: [],
        allowedSysappIds: [],
        revokePermSysappIds: grantorInst,
        grantorSysappIds: grantorInst,
      });
      if (!okClear) {
        return res.json({ success: false, msg: 'No se pudo guardar permisos.' });
      }
      await usersModelMain.replacePaginaScopesForUser(idus, {}, {
        revokeScopeSysappIds: grantorInst,
        allowedSysappIds: [],
      });
      return res.json({ success: true });
    }

    for (const p of permisosUsuario) {
      const sid = parseInt(p.id_syssubmod, 10);
      const aid = parseInt(p.id_app, 10);
      if (!Number.isFinite(sid) || !Number.isFinite(aid)) continue;
      if (!allowedSysappIds.includes(aid)) {
        return res.json({ success: false, msg: 'Instancia no permitida en los permisos.' });
      }
      const ok = await grantorHasSysPerm(grantor, sid, aid);
      if (!ok) {
        return res.json({ success: false, msg: 'No puedes otorgar uno de los permisos seleccionados.' });
      }
    }

    const idsSub = permisosUsuario.map((p) => parseInt(p.id_syssubmod, 10)).filter((n) => Number.isFinite(n));
    const paginasSubmods = await syssubmodIdsSonModuloPaginas(idsSub);
    const appsConPaginas = new Set();
    for (const p of permisosUsuario) {
      const sid = parseInt(p.id_syssubmod, 10);
      const aid = parseInt(p.id_app, 10);
      if (paginasSubmods.has(sid)) appsConPaginas.add(aid);
    }
    const paginaScopeNorm = normalizePaginaScopeFromBody(paginaScope);
    for (const appKey of Object.keys(paginaScopeNorm)) {
      const scopeForApp = paginaScopeNorm[appKey];
      if (!scopeForApp || typeof scopeForApp !== 'object' || Array.isArray(scopeForApp)) continue;
      if (!Object.keys(scopeForApp).length) continue;
      const appId = parseInt(appKey, 10);
      if (!Number.isFinite(appId)) continue;
      const tieneModuloPaginas = permisosUsuario.some((p) => {
        const aid = parseInt(p.id_app, 10);
        const sid = parseInt(p.id_syssubmod, 10);
        return Number.isFinite(aid) && aid === appId && Number.isFinite(sid) && paginasSubmods.has(sid);
      });
      if (!tieneModuloPaginas) {
        return res.json({
          success: false,
          msg: 'Debe marcar el submódulo Páginas en cada instancia donde defina alcance de páginas.',
        });
      }
    }
    const valAlc = await validatePaginaAlcancePayload(paginaScopeNorm, appsConPaginas);
    if (!valAlc.ok) {
      return res.json({ success: false, msg: valAlc.msg });
    }

    const okUp = await usersModelMain.updateUserInstance({
      id_user: idus,
      email: correoFinal,
      id_type: String(id_type),
      /** Misma regla que el bloque sin permisos: no tocar `fk_id_cat_type_users` del usuario existente. */
      preserveUserType: true,
      permisos: permisosUsuario,
      allowedSysappIds,
      revokePermSysappIds: grantorInst,
      grantorSysappIds: grantorInst,
    });
    if (!okUp) {
      return res.json({ success: false, msg: 'No se pudo guardar permisos.' });
    }

    await usersModelMain.ensureSysappUserPermForUser(idus, allowedSysappIds, grantor);

    const scopeFiltered = {};
    for (const aid of allowedSysappIds) {
      const k = String(aid);
      if (paginaScopeNorm[k]) scopeFiltered[k] = paginaScopeNorm[k];
    }
    await usersModelMain.replacePaginaScopesForUser(idus, scopeFiltered, {
      allowedSysappIds,
      revokeScopeSysappIds: grantorInst,
    });

    res.json({ success: true });
  } catch (e) {
    console.error('editarPermisosUserInstance', e);
    res.json({ success: false, msg: 'Error' });
  }
}

module.exports = {
  users,
  adduser,
  NuevoUsuarioValidarCurp,
  obtenerPermisosUser,
  obtenerPermisosUserInstance,
  editarPermisosUser,
  editarPermisosUserInstance,
  obtenerAdminView,
  obtenerAdminViewInstance,
  obtenerPaginaScopeUserInstance,
  opcionesPaginasAlcanceInstancia,
  deActiveUser,
  reActiveUser,
  actualizarContrasenaUser,
  ensureSuperUsersAccess: function (req, res, next) {
    if (hasArchivoAccess(req, '/users')) return next();
    return res.status(403).json({ success: false, msg: 'Sin acceso al módulo de usuarios.' });
  },
  ensureInstanceUsersAccess: function (req, res, next) {
    if (hasArchivoAccess(req, '/users-instancia')) {
      req.usuariosScope = 'instance';
      return next();
    }
    return res.status(403).json({ success: false, msg: 'Sin acceso al submódulo de usuarios por instancia.' });
  },
};
