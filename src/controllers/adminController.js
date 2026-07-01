const { Op,Sequelize } = require('sequelize');
const sysappModel = require('../models/AppsModel');
const {Storage} = require("@google-cloud/storage");
const { genCode, enviarEmail, normalizeConcatenatedMediaUrl, isValidCurpFormat } = require("../util/util");
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
const dbConection = require('../config/postgresMain');
/** Misma conexión que CatalogModel.getPermisos (menú lateral); sys_perm debe escribirse aquí para que se vea. */
const pgCatalog = require('../config/postgressdb');
const rel_sysapp_groupModel = require('../models/rel_sysapp_group');
const rel_sysapp_filesModel = require('../models/rel_sysapp_files');
const filesModel = require('../models/files');
const modulosModel = require('../models/modulos');
const sub_moduloModel = require('../models/sub_modulo');
const sys_permModel = require('../models/sys_perm');
const sysapp_user_permModel = require('../models/sysapp_user_perm');
const HostingModel = require('../models/HostingModel');
const HostingStatusModel = require('../models/HostingStatusModel');
const usersModel = require('../models/users');
const usersMainModel = require('../models/usersmain');
const { createDefaultTemplates } = require('../scripts/createDefaultTemplates');
const { registraBitacora, registraBitacoraInsert, ACCION: BITACORA } = require('../util/bitacora');

const storage = new Storage({
    projectId: process.env.PUBLIC_BUCKET_NAME,
    keyFilename: `certs/${process.env.PUBLIC_BUCKET_KEY}`
});

const bucket = storage.bucket(process.env.PUBLIC_BUCKET_NAME);

/** Mensaje seguro para el cliente (sin detalles técnicos ni textos en inglés). */
const MSG_ERROR_SERVIDOR_ES =
    'No se pudo completar la operación. Intenta de nuevo más tarde o contacta al administrador del sistema.';

function responderErrorInterno(res, err, logLabel) {
    console.error(logLabel || '[adminController]', err?.message || err);
    return res.status(500).json({ success: false, error: 1, message: MSG_ERROR_SERVIDOR_ES });
}

/** Texto seguro para insertar rutas de sistema en HTML de correo. */
function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Evita timeouts de proxy/nginx: el POST devuelve jobId y el cliente hace polling con peticiones cortas. */
const solicitarDominioJobs = new Map();
const solicitarDominioLocksPorInstancia = new Set();
const SOLICITAR_DOMINIO_JOB_TTL_MS = 60 * 60 * 1000;

function limpiarSolicitarDominioJobsExpirados() {
    const now = Date.now();
    for (const [jobId, j] of solicitarDominioJobs.entries()) {
        if (now - j.startedAt > SOLICITAR_DOMINIO_JOB_TTL_MS) {
            solicitarDominioJobs.delete(jobId);
        }
    }
}

/**
 * Lógica pesada de solicitar dominio (HTML estático + hosting + correo).
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function ejecutarSolicitarDominioTrabajo(id_user, idapp) {
    const instancia = await sysappModel.findOne({ where: { id_sysapp: idapp, vigente: true } });
    if (!instancia) {
        return { success: false, message: 'Instancia no encontrada' };
    }

    const dominio = normalizeRequestedDomain(instancia.urluri);
    if (!dominio) {
        return { success: false, message: 'Configure el dominio deseado en la instancia antes de solicitar' };
    }

    const hosting = await HostingModel.findOne({ where: { fk_id_sysapp: idapp } });
    if (hosting) {
        if (hosting.fk_id_estatus_hosting === 1) {
            return { success: false, message: 'Ya existe una solicitud de dominio pendiente' };
        }
        if (hosting.fk_id_estatus_hosting === 2) {
            return { success: false, message: 'La instancia ya tiene dominio asignado' };
        }
        if (hosting.fk_id_estatus_hosting === 4 || hosting.fk_id_estatus_hosting === 5) {
            return {
                success: false,
                message:
                    'Esta instancia tiene una baja de dominio solicitada/procesada. No es posible generar una nueva solicitud.'
            };
        }
    }

    const staticGenerator = require('../util/staticGenerator');
    const { pagina } = require('../models/paginasModel');

    let objapp = null;
    if (global.catalogos && global.catalogos.cat_apps_activas) {
        objapp = global.catalogos.cat_apps_activas.find((app) => app.id_sysapp === idapp);
    }
    const instPlain = instancia?.get ? instancia.get({ plain: true }) : instancia;
    objapp = { ...(objapp || {}), ...instPlain, id_sysapp: idapp };

    const paginasVigentes = await pagina.findAll({
        where: { fk_id_sysapp: idapp, vigente: true },
        raw: true
    });

    const errores = [];
    let tieneEntradas = false;
    console.log('[solicitarDominio] Generando HTML estático para', paginasVigentes.length, 'páginas (instancia', idapp, ')');
    for (const pag of paginasVigentes) {
        try {
            const tipoPagina = Number(pag.fk_id_cat_type_pagina) || 0;
            if (tipoPagina === 5) {
                tieneEntradas = true;
                const detalleResult = await staticGenerator.generateAndSaveStaticHTMLForEntradaDetalle(
                    objapp,
                    pag.id_wb_pagina,
                    pag.url_safe
                );
                if (!detalleResult) {
                    errores.push(
                        `Entrada ${pag.id_wb_pagina} (${pag.nombre_pagina || pag.url_safe || '/'}): no se pudo cargar para generar detalle.`
                    );
                } else {
                    console.log('[solicitarDominio] OK entrada detalle', pag.id_wb_pagina, pag.url_safe || '/');
                }
            } else {
                const paginasCompletas = await pagina.getDataPaginaID(pag.id_wb_pagina);
                const paginaCompleta =
                    Array.isArray(paginasCompletas) && paginasCompletas.length > 0
                        ? paginasCompletas[0].get
                            ? paginasCompletas[0].get({ plain: true })
                            : paginasCompletas[0]
                        : null;
                if (!paginaCompleta) {
                    errores.push(`Página ${pag.id_wb_pagina} (${pag.url_safe || '/'}): no se pudo cargar.`);
                    continue;
                }
                await staticGenerator.generateAndSaveStaticHTML(
                    objapp,
                    paginaCompleta,
                    pag.url_safe || '/',
                    pag.fk_id_cat_type_pagina || 2
                );
                console.log('[solicitarDominio] OK página', pag.id_wb_pagina, pag.url_safe || '/');
            }
        } catch (pageError) {
            console.error('[solicitarDominio] Error generando HTML para página', pag.id_wb_pagina, ':', pageError.message);
            errores.push(`Página ${pag.id_wb_pagina} (${pag.nombre_pagina || pag.url_safe || '/'}): ${pageError.message}`);
        }
    }

    if (tieneEntradas) {
        try {
            await staticGenerator.generateAndSaveStaticHTMLForEntradasList(objapp);
            console.log('[solicitarDominio] OK listado entradas (entradas.html)');
        } catch (listError) {
            console.error('[solicitarDominio] Error generando listado de entradas:', listError.message);
            errores.push('Listado de entradas: ' + listError.message);
        }
    }

    try {
        await staticGenerator.generateAndSaveStaticHTMLForRegeneracion(objapp);
        console.log('[solicitarDominio] OK página regeneración (regeneracion.html)');
    } catch (regenError) {
        console.error('[solicitarDominio] Error generando página de regeneración:', regenError.message);
        errores.push('Página de regeneración: ' + regenError.message);
    }

    if (errores.length > 0) {
        return {
            success: false,
            message: 'No se pudo generar el HTML estático. La solicitud no se completó. Errores: ' + errores.join(' ')
        };
    }

    let hostingActual = hosting;
    if (!hostingActual) {
        hostingActual = await HostingModel.create({
            fk_id_sysapp: idapp,
            fk_id_estatus_hosting: 1,
            dominio_solicitado: dominio,
            solicitado_por: id_user,
            f_solicitud: new Date(),
            paginas_completadas: true,
            f_paginas_completadas: new Date()
        });
    } else if (hostingActual.fk_id_estatus_hosting !== 1) {
        await hostingActual.update({
            fk_id_estatus_hosting: 1,
            dominio_solicitado: dominio,
            solicitado_por: id_user,
            f_solicitud: new Date(),
            paginas_completadas: true,
            f_paginas_completadas: new Date()
        });
    }

    const idHostingBitacora =
        hostingActual && hostingActual.id_hosting != null ? hostingActual.id_hosting : null;
    if (id_user && idHostingBitacora) {
        void registraBitacora({
            fk_id_user_actor: id_user,
            accion: BITACORA.DOMINIO_SOLICITUD,
            fk_id_sysapp: idapp,
            id_hosting: idHostingBitacora,
            detalle: {
                dominio_solicitado: dominio,
                sysapp_name: instancia.sysapp_name,
            },
            req: null,
        });
    }

    const solicitante = await usersModel.findOne({ where: { id_user }, raw: true });
    const nombreSolicitante = solicitante
        ? [solicitante.nombre, solicitante.primer_apellido, solicitante.segundo_apellido].filter(Boolean).join(' ')
        : 'Usuario';
    const correoSolicitante = solicitante?.email || '';

    const distDirProduccion = escapeHtmlAttr(staticGenerator.getDistDirBase(idapp, objapp));

    const destino = process.env.INFRA_MAIL || process.env.MAIL_ORIGIN || '';
    if (destino) {
        const imagePathTop = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_2.png');
        const imagePathBottom = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_1.jpg');
        const bodyInfra = `<html>
                        <body style="margin:0; padding:0; text-align:center;">
                            <div style="max-width:800px; margin:0 auto; text-align:center;">
                                <img src="cid:topImage" style="width:100%; max-width:800px; display:block;">
                                <div style="max-width:600px; margin:0 auto; padding:30px 20px; font-family:Montserrat, Arial, sans-serif; color:#021B23; text-align:center;">
                                    <h2 style="font-weight:800; color:#8e2c2d; margin:20px 0; font-size:1.8rem;">SOLICITUD DE DOMINIO PARA INSTANCIA CMS MORENA</h2>
                                    <hr style="border:none; height:3px; width:120px; background-color:#8e2c2d; margin:10px auto 25px auto;">
                                    <p style="color:#333; font-size:15px; text-align:center; line-height:1.6; margin:25px 0;">Se solicita la asignación del siguiente dominio para la instancia del Sistema de Administración de Contenido Institucional.</p>
                                    <div style="background-color:#f5f5f5; border:2px solid #8e2c2d; border-radius:8px; padding:20px; margin:25px auto; max-width:450px; text-align:left;">
                                        <p style="margin:10px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Instancia:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${instancia.sysapp_name}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Dominio solicitado:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${dominio}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Ubicación en servidor (distDir):</p>
                                        <p style="margin:5px 0; font-size:0.95rem; color:#000; word-break:break-all;">${distDirProduccion}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Solicitante:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${nombreSolicitante} (${correoSolicitante})</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Fecha:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${new Date().toLocaleString('es-MX')}</p>
                                    </div>
                                </div>
                                <img src="cid:bottomImage" style="width:100%; max-width:800px; display:block;">
                            </div>
                        </body>
                    </html>`;
        await enviarEmail({
            to: destino,
            to_name: 'Infraestructura Tecnológica',
            subject: `[CMS Morena] Solicitud de dominio: ${instancia.sysapp_name}`,
            body: bodyInfra,
            isHTml: true,
            attachments: [
                { path: imagePathTop, filename: 'FIRMA_CORREO_MORENA_2.png', type: 'image/png', disposition: 'inline', cid: 'topImage' },
                { path: imagePathBottom, filename: 'FIRMA_CORREO_MORENA_1.jpg', type: 'image/jpeg', disposition: 'inline', cid: 'bottomImage' }
            ]
        });
    }

    return { success: true, message: 'Solicitud enviada. Infraestructura Tecnológica contactará al respecto.' };
}

/**
 * Si el polling cae en otro nodo (Map en memoria vacío) o el proceso reinició,
 * inferir éxito desde wb_sysapp_hosting cuando la solicitud ya quedó registrada.
 */
async function recuperarEstadoSolicitarDominioDesdeDb(id_user, id_sysapp) {
    const idapp = parseInt(id_sysapp, 10);
    if (!idapp || !id_user) return null;
    const hosting = await HostingModel.findOne({ where: { fk_id_sysapp: idapp } });
    if (!hosting || Number(hosting.fk_id_estatus_hosting) !== 1) return null;
    if (Number(hosting.solicitado_por) !== Number(id_user)) return null;
    const f = hosting.f_solicitud ? new Date(hosting.f_solicitud).getTime() : 0;
    if (!f || Number.isNaN(f) || Date.now() - f > 24 * 60 * 60 * 1000) return null;
    return {
        success: true,
        pending: false,
        done: true,
        result: {
            success: true,
            message: 'Solicitud enviada. Infraestructura Tecnológica contactará al respecto.',
        },
    };
}

async function runSolicitarDominioJob(jobId, id_user, idapp) {
    const job = solicitarDominioJobs.get(jobId);
    if (!job) {
        solicitarDominioLocksPorInstancia.delete(idapp);
        return;
    }
    job.status = 'running';
    try {
        const result = await ejecutarSolicitarDominioTrabajo(id_user, idapp);
        job.status = 'done';
        job.success = result.success;
        job.message = result.message;
        job.finishedAt = Date.now();
    } catch (error) {
        console.error('[solicitarDominio job]', error?.message || error);
        job.status = 'done';
        job.success = false;
        job.message = MSG_ERROR_SERVIDOR_ES;
        job.finishedAt = Date.now();
    } finally {
        solicitarDominioLocksPorInstancia.delete(idapp);
    }
}

/**
 * Alta de responsable con correo/CURP ya en `users`: si es el mismo usuario y aún no tiene rol CMS activo,
 * reutilizar `id_user` en lugar de INSERT (misma regla que registro de usuarios existentes).
 */
async function resolverResponsableExistenteSinCms({ transaction, correoResponsable, curpResponsable }) {
    const { QueryTypes } = require('sequelize');
    const rowsE = await dbConection.query(
        `SELECT id_user, email, curp FROM users WHERE lower(trim(email)) = $1 LIMIT 1`,
        { bind: [correoResponsable], type: QueryTypes.SELECT, transaction }
    );
    const rowsC = await dbConection.query(
        `SELECT id_user, email, curp FROM users WHERE upper(trim(curp)) = $1 LIMIT 1`,
        { bind: [curpResponsable], type: QueryTypes.SELECT, transaction }
    );
    const uE = rowsE && rowsE[0];
    const uC = rowsC && rowsC[0];

    if (!uE && !uC) {
        return { mode: 'insert' };
    }

    if (uE && uC) {
        if (Number(uE.id_user) !== Number(uC.id_user)) {
            throw new Error(
                'La CURP y el correo electrónico corresponden a dos usuarios distintos. Verifica los datos.'
            );
        }
    } else if (uE && !uC) {
        const dbCurp = String(uE.curp || '').trim().toUpperCase();
        if (dbCurp && dbCurp !== curpResponsable) {
            throw new Error('El correo ya está registrado con otra CURP.');
        }
    } else if (!uE && uC) {
        const dbEm = String(uC.email || '').trim().toLowerCase();
        if (dbEm && dbEm !== correoResponsable) {
            throw new Error('La CURP ya está registrada con otro correo electrónico.');
        }
    }

    const row = uE || uC;
    const id = row.id_user;
    const activeCms = await usersMainModel.getActiveCmsRoleAssignment(id);
    if (activeCms) {
        throw new Error(
            'USUARIO_YA_REGISTRADO_CMS: Este usuario ya tiene acceso al CMS. Selecciónalo en la lista de responsables en lugar de crear uno nuevo.'
        );
    }

    return { mode: 'reuse', id_user: id };
}

/** Igual que en app.js al arrancar: mantiene global.catalogos.cat_apps_activas al día tras crear/editar instancia. */
async function reloadGlobalCatAppsActivas() {
    try {
        const { QueryTypes } = require('sequelize');
        const gid = process.env.GRUPO_APLICACIONES;
        if (gid == null || gid === '') return;
        const rows = await dbConection.query(
            `SELECT id_sysapp, sysapp_name, fk_id_sysapp_type, app_legend, app_desc, key_sysapp, urluri, app_favicon
             FROM sysapp
             LEFT JOIN rel_sysapp_group ON fk_id_sysapp = id_sysapp
             WHERE sysapp.vigente IS TRUE
               AND fk_id_sysapp_group = $1`,
            { type: QueryTypes.SELECT, bind: [gid] }
        );
        if (global.catalogos && rows != null) {
            global.catalogos.cat_apps_activas = rows;
        }
    } catch (e) {
        console.error('[reloadGlobalCatAppsActivas]', e?.message || e);
    }
}

/** Catálogo (postgressdb) y main apuntan al mismo nombre de BD → una sola transacción puede escribir sys_perm antes del commit. */
function catalogDbIsSameAsMain() {
    return String(process.env.PGDB_NAME || '') === String(process.env.PGDB_NAME_MAIN || '');
}

/**
 * Alta de instancia ya hizo COMMIT en main pero falló la bitácora en catálogo: deshace lo mínimo para no dejar instancia «a medias».
 * Solo para `idEditNum === 0` (nueva instancia).
 */
async function revertirAltaInstanciaPorFalloBitacora(ctx) {
    const { idapp, idResponsable, crearResponsableNuevo } = ctx || {};
    const id = parseInt(idapp, 10);
    if (!Number.isFinite(id) || id <= 0) return;
    const { QueryTypes } = require('sequelize');
    const t = await dbConection.transaction();
    try {
        await dbConection.query(
            `UPDATE sys_perm SET vigente = false, f_revoca = NOW()
             WHERE fk_id_sysapp = $1::integer AND (vigente IS NOT FALSE)`,
            { bind: [id], type: QueryTypes.UPDATE, transaction: t }
        );
        await dbConection.query(`DELETE FROM sysapp_user_perm WHERE fk_id_sysapp = $1::integer`, {
            bind: [id],
            type: QueryTypes.DELETE,
            transaction: t,
        });
        await dbConection.query(`DELETE FROM rel_sysapp_group WHERE fk_id_sysapp = $1::integer`, {
            bind: [id],
            type: QueryTypes.DELETE,
            transaction: t,
        });
        await sysappModel.update({ vigente: false }, { where: { id_sysapp: id }, transaction: t });
        if (crearResponsableNuevo && Number.isFinite(parseInt(idResponsable, 10))) {
            const uid = parseInt(idResponsable, 10);
            await dbConection.query(
                `UPDATE users SET activo = false, vigente = false WHERE id_user = $1::integer`,
                { bind: [uid], type: QueryTypes.UPDATE, transaction: t }
            );
        }
        await t.commit();
    } catch (e) {
        try {
            await t.rollback();
        } catch (_) {
            /* ignore */
        }
        throw e;
    }
}

/**
 * Evita duplicate key en id_sys_perm cuando la secuencia quedó detrás del MAX(id).
 * Si sys_perm es foreign table (FDW), pg_get_serial_sequence puede ser NULL en el catálogo:
 * en ese caso la secuencia real está en postgresMain → usar alignSysPermSequenceCatalogAndMain.
 */
async function alignSysPermSequence(sequelize, transaction) {
    const { QueryTypes } = require('sequelize');
    if (!sequelize) return;
    const opts = { type: QueryTypes.RAW, transaction };
    try {
        await sequelize.query(
            `DO $body$
            DECLARE
              seq text;
              mx bigint;
            BEGIN
              SELECT COALESCE(MAX(id_sys_perm), 0) INTO mx FROM sys_perm;
              seq := pg_get_serial_sequence('sys_perm', 'id_sys_perm');
              IF seq IS NULL AND to_regclass('public.sys_perm_id_sys_perm_seq') IS NOT NULL THEN
                seq := 'public.sys_perm_id_sys_perm_seq';
              END IF;
              IF seq IS NOT NULL THEN
                PERFORM setval(seq::regclass, GREATEST(mx, 1), true);
              END IF;
            END
            $body$ LANGUAGE plpgsql`,
            opts
        );
    } catch (e) {
        console.warn('[alignSysPermSequence]', sequelize?.config?.database, e?.message || e);
    }
}

/** Alinea secuencia en la conexión usada y, si no es main, también en postgresMain (donde vive la secuencia con FDW). */
async function alignSysPermSequenceCatalogAndMain(sequelize, transaction) {
    await alignSysPermSequence(sequelize, transaction);
    if (sequelize !== dbConection) {
        await alignSysPermSequence(dbConection, undefined);
    }
}

function isSysPermUniqueViolation(err) {
    return (
        err?.name === 'SequelizeUniqueConstraintError' ||
        err?.parent?.code === '23505' ||
        err?.original?.code === '23505'
    );
}

/**
 * Obtiene el dominio solicitado "real" para Infra a partir de la URL de instancia.
 * Ejemplos:
 * - dev-cms.morena.app//morena-sonora -> morena-sonora
 * - https://dev-cms.morena.app/morena-sonora -> morena-sonora
 * - morena-sonora.mx -> morena-sonora.mx
 */
function normalizeRequestedDomain(rawValue = '') {
    const value = String(rawValue || '').trim();
    if (!value) return '';

    let cleaned = value
        .replace(/^https?:\/\//i, '')
        .replace(/[?#].*$/, '')
        .replace(/\/{2,}/g, '/')
        .replace(/^\/+|\/+$/g, '');

    const baseUrlRaw = String(process.env.APP_BASE_URL || '').trim();
    if (baseUrlRaw) {
        const baseHost = baseUrlRaw
            .replace(/^https?:\/\//i, '')
            .replace(/[?#].*$/, '')
            .replace(/\/+$/g, '');

        if (baseHost && cleaned.toLowerCase().startsWith(baseHost.toLowerCase() + '/')) {
            cleaned = cleaned.slice(baseHost.length + 1).replace(/^\/+|\/+$/g, '');
        } else if (baseHost && cleaned.toLowerCase() === baseHost.toLowerCase()) {
            cleaned = '';
        }
    }

    // Si quedó como host/ruta, tomar la última parte útil (slug o dominio objetivo).
    if (cleaned.includes('/')) {
        const segments = cleaned.split('/').filter(Boolean);
        cleaned = segments.length ? segments[segments.length - 1] : cleaned;
    }

    return cleaned.trim();
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

function isResponsablePerfil(req) {
    const typeName = String(req.usdata?.type_user || '').toLowerCase();
    return typeName.includes('responsable');
}

/** Expresión SQL: ruta de menú comparable (tildes → ASCII, guiones bajos → guión) para rutas.archivo. */
function sqlArchivoNorm(aliasTable = 'r') {
    return `translate(trim(both '/' from lower(replace(coalesce(${aliasTable}.archivo, ''), '_', '-'))), 'áéíóúüñ', 'aeiouun')`;
}

/** Módulos de catálogo global / admin general: no deben clonarse por instancia en el INSERT masivo de sys_perm. */
function sqlSysmodNotConfiguracionGlobal(aliasTable = 'm') {
    const t = (col) =>
        `translate(lower(trim(coalesce(${aliasTable}.${col}, ''))), 'áéíóúüñ', 'aeiouun')`;
    return `AND ${t('modulo')} NOT LIKE '%configuracion global%'
          AND ${t('modulo_legend')} NOT LIKE '%configuracion global%'
          AND ${t('modulo')} NOT LIKE '%administrador general%'
          AND ${t('modulo_legend')} NOT LIKE '%administrador general%'`;
}

/**
 * Rutas de administración (pueden existir duplicadas en catálogo bajo "Contenido" u otro módulo de instancia).
 * Solo deben asignarse con grantGeneralAdminRoutes (app nacional), nunca con el INSERT masivo por tipo.
 */
function sqlRutaExcludedFromBulkInstancePerm(aliasR = 'r') {
    const n = sqlArchivoNorm(aliasR);
    return `AND (${n} IS NULL OR ${n} = '' OR (${n} NOT IN ('users-instancia', 'instancias') AND ${n} NOT LIKE 'categorias%'))`;
}

/** Instancia nacional de contenido (tipo 2), p. ej. «Morena Nacional». */
async function getNacionalSysappId(sequelize, transaction) {
    const { QueryTypes } = require('sequelize');
    const conn = sequelize || dbConection;
    const rows = await conn.query(
        `SELECT id_sysapp FROM sysapp WHERE fk_id_sysapp_type = 2 AND (vigente IS NOT FALSE) ORDER BY id_sysapp ASC LIMIT 1`,
        { type: QueryTypes.SELECT, transaction }
    );
    const raw = rows?.[0]?.id_sysapp;
    return raw != null ? parseInt(raw, 10) : null;
}

/** App «Administrador general» (tipo 1): aquí deben colgar categorías / instancias / users-instancia en el menú, no bajo la instancia nacional (tipo 2). */
async function getAdministradorGeneralSysappId(sequelize, transaction) {
    const { QueryTypes } = require('sequelize');
    const conn = sequelize || dbConection;
    const rows = await conn.query(
        `SELECT id_sysapp FROM sysapp WHERE fk_id_sysapp_type = 1 AND (vigente IS NOT FALSE) ORDER BY id_sysapp ASC LIMIT 1`,
        { type: QueryTypes.SELECT, transaction }
    );
    const raw = rows?.[0]?.id_sysapp;
    return raw != null ? parseInt(raw, 10) : null;
}

/**
 * INSERT masivo de sys_perm del responsable para el menú (getPermisos).
 * Si PGDB_NAME = PGDB_NAME_MAIN: se escribe en esa conexión.
 * Si difieren: `sys_perm` en catálogo suele ser tabla foránea (FDW) hacia MAIN; un INSERT…SELECT sin
 * columna id puede enviar id_sys_perm = NULL al remoto (23502). En ese caso se escribe solo en MAIN;
 * las consultas al catálogo siguen viendo los datos vía FDW.
 */
async function insertSysPermResponsablePorTipoInstancia({
    idResponsable,
    idSysapp,
    fkType,
    log,
    sequelize,
    transaction
}) {
    const { QueryTypes } = require('sequelize');
    const fkGroup = parseInt(process.env.GRUPO_APLICACIONES, 10) || 1;
    const mismoNombreDb = catalogDbIsSameAsMain();

    const sql = `
        INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
        SELECT $1::integer, s.id_syssubmod, $2::integer
        FROM syssubmod s
        INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
        LEFT JOIN rutas r ON r.id_ruta = s.fk_id_ruta
        WHERE m.fk_id_sysapp_group = $3::integer
          AND m.fk_id_sysapp_type = $4::integer
          AND (m.vigente IS NOT FALSE)
          AND (s.vigente IS NOT FALSE)
          AND (r.id_ruta IS NULL OR r.vigente IS TRUE)
          ${sqlSysmodNotConfiguracionGlobal('m')}
          ${sqlRutaExcludedFromBulkInstancePerm('r')}
          AND NOT EXISTS (
            SELECT 1 FROM sys_perm ep
            WHERE ep.fk_id_user = $1::integer
              AND ep.fk_id_syssubmod = s.id_syssubmod
              AND ep.fk_id_sysapp = $2::integer
          )`;

    const reactivateSql = `
        UPDATE sys_perm sp
        SET vigente = true, f_revoca = NULL
        FROM syssubmod s
        INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
        LEFT JOIN rutas r ON r.id_ruta = s.fk_id_ruta
        WHERE sp.fk_id_user = $1::integer
          AND sp.fk_id_sysapp = $2::integer
          AND sp.fk_id_syssubmod = s.id_syssubmod
          AND m.fk_id_sysapp_group = $3::integer
          AND m.fk_id_sysapp_type = $4::integer
          AND (m.vigente IS NOT FALSE)
          AND (s.vigente IS NOT FALSE)
          AND (r.id_ruta IS NULL OR r.vigente IS TRUE)
          ${sqlSysmodNotConfiguracionGlobal('m')}
          ${sqlRutaExcludedFromBulkInstancePerm('r')}
          AND (sp.vigente IS FALSE OR sp.f_revoca IS NOT NULL)`;

    const bind = [idResponsable, idSysapp, fkGroup, fkType];
    log('INSERT masivo sys_perm responsable en postgressdb (menú)', { idResponsable, idSysapp, fkGroup, fkType });

    const run = async (conn, txn) => {
        const exec = async () => {
            await alignSysPermSequenceCatalogAndMain(conn, txn);
            await conn.query(sql, { bind, type: QueryTypes.INSERT, transaction: txn });
            await conn.query(reactivateSql, { bind, type: QueryTypes.UPDATE, transaction: txn });
        };
        try {
            await exec();
        } catch (e) {
            if (!isSysPermUniqueViolation(e)) throw e;
            await alignSysPermSequence(dbConection, undefined);
            await alignSysPermSequence(conn, txn);
            await exec();
        }
    };

    if (sequelize) {
        await run(sequelize, transaction);
        return;
    }

    if (mismoNombreDb) {
        await run(pgCatalog, undefined);
    } else {
        log('sys_perm responsable: INSERT solo en PGDB_NAME_MAIN (evita FDW id_sys_perm NULL en catálogo)');
        await run(dbConection, undefined);
    }
}

/**
 * Permisos sobre rutas de administración: instancias, categorías y users-instancia.
 * Se escribe en `postgressdb` (misma BD que getPermisos).
 * Un syssubmod por ruta (DISTINCT ON). Para instancias/categorías se prefiere el sysmod del mismo tipo
 * que la instancia; para users-instancia se prefiere sysmod de catálogo global (fk_id_sysapp_type 1 o 2,
 * p. ej. Configuración global) si hay duplicados en catálogo.
 *
 * `fk_id_sysapp` en sys_perm debe ser la app «Administrador general» (tipo 1), no la instancia nacional
 * de contenido (tipo 2), para que el bloque quede en esa carpeta del menú. Si no existe app tipo 1, se usa
 * la nacional (tipo 2) como respaldo. sqlArchivoNorm quita tildes para coincidir p. ej. categorías → categorias.
 */
async function grantGeneralAdminRoutesForResponsibleInstance({
    idUser,
    idSysapp,
    fkSysappType,
    sequelize,
    transaction
}) {
    const { QueryTypes } = require('sequelize');
    const uid = parseInt(idUser, 10);
    const aid = parseInt(idSysapp, 10);
    const tInst = parseInt(fkSysappType, 10);
    const fkGroup = parseInt(process.env.GRUPO_APLICACIONES, 10) || 1;
    const mismoNombreDb = catalogDbIsSameAsMain();
    const log = (...a) => console.log('[grantAdminRoutes]', ...a);

    const archivoNorm = sqlArchivoNorm('r');

    log('inicio', {
        uid,
        aid,
        fkSysappType: tInst,
        fkGroup,
        PGDB_NAME: process.env.PGDB_NAME,
        PGDB_NAME_MAIN: process.env.PGDB_NAME_MAIN,
        mismoCatalogoQueMain: mismoNombreDb
    });

    if (!Number.isFinite(uid) || !Number.isFinite(aid)) {
        log('abort: uid o idSysapp no finitos');
        return;
    }
    const typePrefer = tInst === 2 || tInst === 3 ? tInst : 3;

    let aidPerm = aid;
    const adminGralId = await getAdministradorGeneralSysappId(sequelize || pgCatalog, transaction);
    if (Number.isFinite(adminGralId)) {
        aidPerm = adminGralId;
        log('rutas admin (instancias/categorías/users-instancia) → fk_id_sysapp Administrador general (tipo 1)', {
            idInstanciaContexto: aid,
            fkSysappType: tInst,
            idAdminGeneral: adminGralId
        });
    } else if (tInst === 3) {
        const nacionalId = await getNacionalSysappId(sequelize || pgCatalog, transaction);
        if (Number.isFinite(nacionalId)) {
            aidPerm = nacionalId;
            log('rutas admin (fallback sin app tipo 1) → fk_id_sysapp instancia nacional tipo 2', {
                idInstanciaSecundaria: aid,
                idNacional: nacionalId
            });
        }
    }

    const runOnConn = async (conn, txn) => {
        const candidatos = await conn.query(
            `SELECT ${archivoNorm} AS archivo_n,
                    m.fk_id_sysapp_type,
                    m.modulo_legend,
                    s.id_syssubmod,
                    r.archivo AS archivo_raw
             FROM syssubmod s
             INNER JOIN rutas r ON r.id_ruta = s.fk_id_ruta
             INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
             WHERE (s.vigente IS NOT FALSE)
               AND (m.vigente IS NOT FALSE)
               AND m.fk_id_sysapp_group = $1::integer
               AND (r.vigente IS TRUE)
               AND ${archivoNorm} IN ('instancias', 'categorias', 'users-instancia')
             ORDER BY ${archivoNorm},
                      CASE
                        WHEN ${archivoNorm} = 'users-instancia' AND m.fk_id_sysapp_type IN (1, 2) THEN 0
                        WHEN ${archivoNorm} = 'users-instancia' THEN 1
                        ELSE m.fk_id_sysapp_type
                      END,
                      s.id_syssubmod`,
            { bind: [fkGroup], type: QueryTypes.SELECT, transaction: txn }
        );
        log('candidatos en catálogo (rutas admin instancia):', candidatos?.length ?? 0, candidatos);

        const insertAdminRoutes = async () => {
            await alignSysPermSequenceCatalogAndMain(conn, txn);
            return conn.query(
                `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp, vigente)
                 SELECT DISTINCT ON (${archivoNorm})
                   $1::integer, s.id_syssubmod, $2::integer, TRUE
                 FROM syssubmod s
                 INNER JOIN rutas r ON r.id_ruta = s.fk_id_ruta
                 INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                 WHERE (s.vigente IS NOT FALSE)
                   AND (m.vigente IS NOT FALSE)
                   AND m.fk_id_sysapp_group = $4::integer
                   AND (r.vigente IS TRUE)
                   AND NOT EXISTS (
                     SELECT 1 FROM sys_perm spx
                     WHERE spx.fk_id_user = $1::integer
                       AND spx.fk_id_syssubmod = s.id_syssubmod
                       AND spx.fk_id_sysapp = $2::integer
                       AND (spx.vigente IS NOT FALSE)
                   )
                   AND ${archivoNorm} IN ('instancias', 'categorias', 'users-instancia')
                 ORDER BY ${archivoNorm},
                          CASE
                            WHEN ${archivoNorm} = 'users-instancia' AND m.fk_id_sysapp_type IN (1, 2) THEN 0
                            WHEN ${archivoNorm} = 'users-instancia' THEN 1
                            WHEN m.fk_id_sysapp_type = $3::integer THEN 0
                            ELSE 1
                          END,
                          s.id_syssubmod
                 RETURNING id_sys_perm, fk_id_syssubmod, fk_id_sysapp`,
                {
                    bind: [uid, aidPerm, typePrefer, fkGroup],
                    type: QueryTypes.SELECT,
                    transaction: txn
                }
            );
        };

        let inserted;
        try {
            inserted = await insertAdminRoutes();
        } catch (e) {
            if (!isSysPermUniqueViolation(e)) throw e;
            await alignSysPermSequence(dbConection, undefined);
            await alignSysPermSequence(conn, txn);
            inserted = await insertAdminRoutes();
        }
        log('INSERT sys_perm (postgressdb) filas:', Array.isArray(inserted) ? inserted.length : 0, inserted);

        /**
         * Si el INSERT no añade filas porque ya existían filas revocadas (vigente = false),
         * NOT EXISTS permite intentar INSERT pero puede fallar por UNIQUE; además getPermisos
         * excluye vigente = false. Reactivamos explícitamente las rutas admin sobre fk_id_sysapp.
         */
        const reactivateSql = `
            UPDATE sys_perm sp
            SET vigente = true, f_revoca = NULL
            FROM syssubmod s
            INNER JOIN rutas r ON r.id_ruta = s.fk_id_ruta
            INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
            WHERE sp.fk_id_user = $1::integer
              AND sp.fk_id_sysapp = $2::integer
              AND sp.fk_id_syssubmod = s.id_syssubmod
              AND (m.vigente IS NOT FALSE)
              AND m.fk_id_sysapp_group = $3::integer
              AND (r.vigente IS TRUE)
              AND (s.vigente IS NOT FALSE)
              AND ${archivoNorm} IN ('instancias', 'categorias', 'users-instancia')
            RETURNING sp.id_sys_perm, sp.fk_id_syssubmod`;
        let reactivated;
        try {
            reactivated = await conn.query(reactivateSql, {
                bind: [uid, aidPerm, fkGroup],
                type: QueryTypes.SELECT,
                transaction: txn
            });
        } catch (eRe) {
            log('reactivar sys_perm admin (error, ignorar si esquema distinto):', eRe?.message || eRe);
            reactivated = [];
        }
        log('UPDATE sys_perm reactivadas (rutas admin, mismo fk_id_sysapp):', Array.isArray(reactivated) ? reactivated.length : 0, reactivated);

        if (!inserted?.length && (candidatos?.length ?? 0) > 0) {
            const nReac = Array.isArray(reactivated) ? reactivated.length : 0;
            if (nReac > 0) {
                log(
                    'rutas admin: sin filas nuevas en INSERT; se reactivaron permisos existentes (estaban revocados):',
                    nReac
                );
            } else {
                log('advertencia: había candidatos en catálogo pero INSERT no insertó ni hubo reactivaciones');
            }
        }
        if (!(candidatos?.length > 0)) {
            log('advertencia: no hay filas en syssubmod/rutas/sysmod para instancias|categorias|users-instancia con este grupo. Revisa catálogo en BD.');
        }
    };

    if (sequelize) {
        await runOnConn(sequelize, transaction);
        return;
    }

    if (mismoNombreDb) {
        await runOnConn(pgCatalog, undefined);
    } else {
        log('grant admin routes: INSERT solo en PGDB_NAME_MAIN (mismo criterio FDW sys_perm)');
        await runOnConn(dbConection, undefined);
    }
}

/**
 * Tras crear instancia: todos los sys_perm del responsable deben ir a postgressdb (menú).
 * Incluye el bloque por tipo de instancia + rutas de administración general.
 */
async function syncResponsableSysPermAfterCreate({ idResponsable, idSysapp, fkType, logCI, sequelize, transaction }) {
    await insertSysPermResponsablePorTipoInstancia({
        idResponsable,
        idSysapp,
        fkType,
        log: logCI,
        sequelize,
        transaction
    });
    await grantGeneralAdminRoutesForResponsibleInstance({
        idUser: idResponsable,
        idSysapp: idSysapp,
        fkSysappType: fkType,
        sequelize,
        transaction
    });
}

async function ensureResponsibleTypeId({ transaction }) {
    const typeName = 'Responsable de instancia';
    const existing = await dbConection.query(
        `SELECT id_cat_type_users
         FROM cat_type_users
         WHERE LOWER(type_user) = LOWER($1)
         ORDER BY id_cat_type_users ASC
         LIMIT 1`,
        {
            bind: [typeName],
            type: require('sequelize').QueryTypes.SELECT,
            transaction
        }
    );
    if (existing && existing.length) {
        return parseInt(existing[0].id_cat_type_users, 10);
    }

    const nextIdRow = await dbConection.query(
        `SELECT COALESCE(MAX(id_cat_type_users), 0) + 1 AS next_id
         FROM cat_type_users`,
        {
            type: require('sequelize').QueryTypes.SELECT,
            transaction
        }
    );
    const nextId = parseInt(nextIdRow?.[0]?.next_id, 10);
    if (!Number.isFinite(nextId)) {
        throw new Error('No fue posible generar id para tipo de usuario responsable.');
    }

    await dbConection.query(
        `INSERT INTO cat_type_users (id_cat_type_users, type_user, vigente)
         VALUES ($1, $2, true)`,
        {
            bind: [nextId, typeName],
            type: require('sequelize').QueryTypes.INSERT,
            transaction
        }
    );
    return nextId;
}

/** Vista de instancias con datos de hosting (logo, estatus dominio). */
async function instanciasList(req, res){
    const { QueryTypes } = require('sequelize');
    try {
        // Hosting vive en otra DB (HostingModel), por eso NO podemos referenciar wb_sysapp_hosting dentro
        // del SQL de postgresMain. En su lugar, obtenemos IDs de sysapp con hosting 4/5 y luego
        // consultamos sysapp en postgresMain con IN (:ids).
        const hostingsBajaIntermedia = await HostingModel.findAll({
            where: { fk_id_estatus_hosting: { [Op.in]: [4, 5] } },
            attributes: ['fk_id_sysapp'],
            raw: true
        });
        const idsSysappBajaIntermedia = hostingsBajaIntermedia.map(h => h.fk_id_sysapp);
        // Para evitar IN () vacío
        const idsBaja = idsSysappBajaIntermedia.length ? idsSysappBajaIntermedia : [-1];

        const isResponsable = isResponsablePerfil(req);
        const whereIdsByUser = isResponsable ? ` AND s.id_sysapp IN (
                SELECT sup.fk_id_sysapp
                FROM sysapp_user_perm sup
                WHERE sup.fk_id_user = :idUser
                  AND (sup.activo IS NOT FALSE)
            )` : '';
        const instanciaslist = await dbConection.query(
            `SELECT s.*, (COALESCE(st.storage_path,'') || COALESCE(f.file_path,'')) AS app_logo
             FROM sysapp s
             LEFT JOIN rel_sysapp_files r ON r.fk_id_sysapp = s.id_sysapp AND r.fk_id_cat_type_files = 8 AND (r.vigente IS NOT FALSE)
             LEFT JOIN files f ON f.id_file = r.fk_id_file
             LEFT JOIN storage_files st ON st.id_storage = f.fk_id_storage
             WHERE s.fk_id_sysapp_type IN (2, 3)
               AND (s.vigente = true OR s.id_sysapp IN (:idsBaja))
               ${whereIdsByUser}
             ORDER BY s.f_reg DESC`,
            { type: QueryTypes.SELECT, replacements: { idsBaja, idUser: req.usdata.id_user } }
        );

        instanciaslist.forEach((inst) => {
            if (inst.app_logo) {
                inst.app_logo = normalizeConcatenatedMediaUrl(inst.app_logo);
            }
        });

        const hostings = await HostingModel.findAll({
            where: { fk_id_sysapp: instanciaslist.map(i => i.id_sysapp) },
            raw: true
        });
        const hostingPorSysapp = hostings.reduce((acc, h) => { acc[h.fk_id_sysapp] = h; return acc; }, {});

        instanciaslist.forEach(inst => {
            const h = hostingPorSysapp[inst.id_sysapp];
            inst.id_hosting = h?.id_hosting;
            inst.fk_id_estatus_hosting = h?.fk_id_estatus_hosting;
            inst.dominio_solicitado = h?.dominio_solicitado;
            inst.dominio_asignado = h?.dominio_asignado;
            inst.paginas_completadas = h?.paginas_completadas;
            inst.f_paginas_completadas = h?.f_paginas_completadas;
        });

        const idsSysappList = instanciaslist.map((i) => i.id_sysapp).filter((id) => id != null);
        if (idsSysappList.length) {
            const respPorInstancia = await dbConection.query(
                `SELECT DISTINCT ON (sup.fk_id_sysapp)
                    sup.fk_id_sysapp AS id_sysapp,
                    u.id_user AS responsable_id_user,
                    u.nombre,
                    u.primer_apellido,
                    u.segundo_apellido,
                    e.estado AS responsable_entidad
                 FROM sysapp_user_perm sup
                 INNER JOIN users u ON u.id_user = sup.fk_id_user
                 INNER JOIN cat_type_users ct ON ct.id_cat_type_users = u.fk_id_cat_type_users
                 LEFT JOIN cat_estados e ON e.id_estado = u.fk_id_estado
                 WHERE sup.fk_id_sysapp = ANY($1::int[])
                   AND (sup.activo IS NOT FALSE)
                   AND LOWER(COALESCE(ct.type_user, '')) LIKE '%responsable%'
                 ORDER BY sup.fk_id_sysapp, sup.fecha_asignacion DESC NULLS LAST`,
                { bind: [idsSysappList], type: QueryTypes.SELECT }
            );
            const mapResp = {};
            for (const row of respPorInstancia || []) {
                mapResp[row.id_sysapp] = row;
            }
            instanciaslist.forEach((inst) => {
                const r = mapResp[inst.id_sysapp];
                inst.responsable_id_user = r?.responsable_id_user != null ? r.responsable_id_user : '';
                inst.responsable_entidad = r?.responsable_entidad || '';
                inst.responsable_nombre = r
                    ? [r.nombre, r.primer_apellido, r.segundo_apellido].filter(Boolean).join(' ')
                    : '';
            });
        }

        // Debe coincidir literalmente con el origen de usuarios del módulo "Administrador de usuarios".
        const responsablesDisponibles = await usersMainModel.findAllBySysappGroup();

        res.render('../views/instancias', {
            ...req.usdata,
            instanciaslist,
            responsables_disponibles: responsablesDisponibles,
            cat_entidades_admins: global.catalogos?.cat_entidad_federativa || [],
            es_responsable_instancia: isResponsablePerfil(req)
        })
    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function CreateInst(req, res) {
    const transaction = await dbConection.transaction();
    const logCI = (...a) => console.log('[CreateInst]', ...a);

    let transactionCommitted = false;
    /** Alta nueva: si `enviarEmail` devuelve error (p. ej. SendGrid Unauthorized), la instancia igual puede quedar creada. */
    let correoResponsableOk = true;
    try {
        const {
            id_edit,
            titlepag,
            cont_alt,
            responsable_id,
            responsable_crear_nuevo,
            responsable_nombre,
            responsable_primer_apellido,
            responsable_segundo_apellido,
            responsable_email,
            responsable_curp,
            responsable_fk_id_estado
        } = req.body;
        let namepag = String(req.body.namepag || '').trim();
        let url = String(req.body.url || '').trim();
        const errores = [];
        const grupoAppId = parseInt(String(process.env.GRUPO_APLICACIONES || '').trim(), 10);
        const idEditNum = parseInt(id_edit, 10) || 0;

        if (isResponsablePerfil(req) && idEditNum === 0) {
            await transaction.rollback();
            return res.status(403).json({
                success: false,
                message: 'No tienes permiso para crear nuevas instancias.'
            });
        }

        if (isResponsablePerfil(req) && idEditNum > 0) {
            const { QueryTypes } = require('sequelize');
            const existInst = await sysappModel.findOne({
                where: { id_sysapp: idEditNum },
                transaction
            });
            if (!existInst) {
                await transaction.rollback();
                return res.status(404).json({ success: false, message: 'Instancia no encontrada.' });
            }
            const acc = await dbConection.query(
                `SELECT 1 FROM sysapp_user_perm WHERE fk_id_sysapp = $1::integer AND fk_id_user = $2::integer AND (activo IS NOT FALSE) LIMIT 1`,
                { bind: [idEditNum, req.usdata.id_user], type: QueryTypes.SELECT, transaction }
            );
            if (!acc || acc.length === 0) {
                await transaction.rollback();
                return res.status(403).json({
                    success: false,
                    message: 'No tienes permiso para modificar esta instancia.'
                });
            }
            namepag = String(existInst.sysapp_name || '').trim();
            let rawUri = String(existInst.urluri || '').trim();
            rawUri = rawUri.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '');
            if (rawUri.includes('/')) {
                const parts = rawUri.split('/').filter(Boolean);
                rawUri = parts.length ? parts[parts.length - 1] : rawUri;
            }
            if (rawUri.toLowerCase().endsWith('.morena.org')) {
                rawUri = rawUri.replace(/\.morena\.org$/i, '');
            } else if (rawUri.includes('.')) {
                rawUri = rawUri.split('.')[0];
            }
            url = rawUri;
            req.body.fk_id_sysapp_type = String(
                existInst.fk_id_sysapp_type != null ? existInst.fk_id_sysapp_type : 3
            );
        }

        const crearResponsableNuevo = String(responsable_crear_nuevo || 'false') === 'true';
        let idResponsable = parseInt(responsable_id, 10);
        let tempPasswordResponsable = '';
        /** Si se creó password temporal (solo INSERT nuevo). Si se reutiliza usuario existente sin CMS, es false. */
        let responsableIncluyePasswordTemporal = crearResponsableNuevo;
        /** Tras commit: sincronizar sys_perm del responsable (alta o cambio en edición). */
        let idUserParaSyncPostCommit = null;

        logCI('solicitud recibida', {
            id_edit: idEditNum,
            namepag,
            fk_id_sysapp_type: req.body.fk_id_sysapp_type,
            crearResponsableNuevo,
            responsable_id_inicial: idResponsable
        });

        // Validaciones básicas
        if (!Number.isFinite(grupoAppId) || grupoAppId <= 0) {
            errores.push(
                'Configuración del servidor incompleta (GRUPO_APLICACIONES). Contacta al administrador.'
            );
        }
        const tituloInstancia = String(titlepag || namepag || '').trim();
        if (tituloInstancia === '') {
            errores.push('El título no puede estar vacío.');
        }
        if (String(namepag || '').trim() === '') {
            errores.push('El nombre no puede estar vacío');
        }

        let fullUrl = '';
        const normalizedSubdomain = String(url || '')
            .trim()
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (normalizedSubdomain === '') {
            errores.push('El subdominio no puede estar vacío');
        } else {
            const subdomainRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
            if (!subdomainRegex.test(normalizedSubdomain)) {
                errores.push('El subdominio solo permite letras, números y guiones intermedios.');
            }
            fullUrl = `${normalizedSubdomain}.morena.org`;

            // Validar que la URL (fullUrl) no esté repetida en otra instancia (nacional y secundarias)
            const whereUrl = {
                fk_id_sysapp_type: { [Op.in]: [2, 3] },
                urluri: fullUrl,
                vigente: true,
            };

            if (idEditNum > 0) {
                // Si es edición, excluir a la misma instancia
                whereUrl.id_sysapp = { [Op.ne]: idEditNum };
            }

            const pags_count = await sysappModel.count({
                where: whereUrl,
                transaction
            });

            if (pags_count > 0) {
                errores.push('La URL ya está asignada a otra instancia');
            }
        }

        const descripcionInstancia = String(cont_alt || 'Pendiente por completar por responsable').trim();
        if (idEditNum === 0) {
            if (crearResponsableNuevo) {
                if (!String(responsable_nombre || '').trim()) errores.push('Nombre del responsable es obligatorio.');
                if (!String(responsable_email || '').trim()) errores.push('Correo del responsable es obligatorio.');
                const curpTrim = String(responsable_curp || '').trim();
                if (!curpTrim) {
                    errores.push('CURP del responsable es obligatorio.');
                } else if (!isValidCurpFormat(curpTrim)) {
                    errores.push('La CURP del responsable no es válida (debe tener entre 18 y 20 caracteres con el formato oficial, no un correo u otro texto).');
                }
                const idEstadoResp = parseInt(responsable_fk_id_estado, 10);
                if (!Number.isFinite(idEstadoResp) || idEstadoResp <= 0) {
                    errores.push('Selecciona la entidad federativa del responsable.');
                }
            } else if (!Number.isFinite(idResponsable)) {
                errores.push('Selecciona un usuario responsable.');
            } else {
                const userResponsable = await dbConection.query(
                    `SELECT id_user FROM users WHERE id_user = $1 AND activo = true LIMIT 1`,
                    { bind: [idResponsable], type: require('sequelize').QueryTypes.SELECT, transaction }
                );
                if (!userResponsable || !userResponsable.length) {
                    errores.push('El usuario responsable seleccionado no está disponible.');
                }
            }
        } else if (idEditNum > 0) {
            if (crearResponsableNuevo) {
                errores.push('En edición debe elegirse un responsable de la lista (no crear usuario nuevo desde aquí).');
            } else if (!Number.isFinite(idResponsable)) {
                errores.push('Selecciona un usuario responsable.');
            } else {
                const userResponsable = await dbConection.query(
                    `SELECT id_user FROM users WHERE id_user = $1 AND activo = true LIMIT 1`,
                    { bind: [idResponsable], type: require('sequelize').QueryTypes.SELECT, transaction }
                );
                if (!userResponsable || !userResponsable.length) {
                    errores.push('El usuario responsable seleccionado no está disponible.');
                }
            }
        }

        // Solo una nacional «en uso»: vigente y no en flujo de baja de dominio (hosting 4/5; ver AppsModel).
        const tipoSolicitado = parseInt(req.body.fk_id_sysapp_type, 10);
        if (tipoSolicitado === 2) {
            const excludeId = idEditNum > 0 ? idEditNum : null;
            const yaHayNacional = await sysappModel.countNacionalVigenteQueBloqueaNueva(excludeId, transaction);
            if (yaHayNacional > 0) {
                errores.push('Solo puede existir una instancia nacional. Elimine la existente si desea registrar otra.');
            }
        }

        if (errores.length > 0) {
            let htmlerro = '<ul>';
            errores.forEach(error => {
                htmlerro += `<li>${error}</li>`;
            });
            htmlerro += '</ul>';
            const erroreshtml = '<p>Por favor valida estos datos</p>' + htmlerro;

            await transaction.rollback();
            return res.status(400).json({ success: false, error: 1, message: erroreshtml });
        }

        // Alta o edición de la instancia (2 = nacional, 3 = secundaria; solo una nacional)
        let idapp = 0;
        const fkType = (tipoSolicitado === 2 || tipoSolicitado === 3) ? tipoSolicitado : 3;
        if (idEditNum === 0) {
            const passtemp = genCode();
            const instcreada = await sysappModel.create(
                {
                    sysapp_name: namepag,
                    fk_id_sysapp_type: fkType,
                    f_reg: new Date(),
                    app_legend: tituloInstancia,
                    app_desc: descripcionInstancia,
                    key_sysapp: passtemp,
                    publicada: false,
                    vigente: true,
                    urluri: fullUrl
                },
                { transaction }
            );
            idapp = instcreada.id_sysapp;
        } else {
            const updatePayload = {
                sysapp_name: namepag,
                app_legend: tituloInstancia,
                app_desc: descripcionInstancia,
                urluri: fullUrl
            };
            if (req.body.fk_id_sysapp_type !== undefined) {
                updatePayload.fk_id_sysapp_type = fkType;
            }
            await sysappModel.update(updatePayload, {
                where: { id_sysapp: idEditNum },
                transaction
            });
            idapp = idEditNum;
        }

        logCI('instancia resuelta', { idapp, fkType, idEditNum });

        // Manejo de archivos (logo y favicon)
        if (req.files && idapp > 0) {
            const nvfile = genCode();

            // Favicon
            if (req.files['cargar-favicon'] && req.files['cargar-favicon'].length !== 0) {
                const faviconFile = req.files['cargar-favicon'][0];
                const faviconname = 'faviconinicial' + nvfile + path.extname(faviconFile.originalname);
                const filename = 'cdn/websites_docs/' + idapp + '/' + faviconname;
                const blob = bucket.file(filename);
                const blobStream = blob.createWriteStream();

                await new Promise((resolve, reject) => {
                    blobStream.on('finish', resolve);
                    blobStream.on('error', reject);
                    blobStream.end(faviconFile.buffer);
                });

                await sysappModel.update({
                    app_favicon: 'https://cdn.morena.app/' + filename,
                }, {
                    where: { id_sysapp: idapp },
                    transaction
                });
            }

            // Logo: guardar en files y rel_sysapp_files con fk_id_cat_type_files = 8 (Logo app)
            if (req.files['cargar-logo'] && req.files['cargar-logo'].length !== 0) {
                const logoFile = req.files['cargar-logo'][0];
                const logoname = 'logoinicial' + nvfile + path.extname(logoFile.originalname);
                const filename2 = 'cdn/websites_docs/' + idapp + '/' + logoname;
                const blob2 = bucket.file(filename2);
                const blobStream2 = blob2.createWriteStream();

                await new Promise((resolve, reject) => {
                    blobStream2.on('finish', resolve);
                    blobStream2.on('error', reject);
                    blobStream2.end(logoFile.buffer);
                });

                const newFile = await filesModel.filesMain.create({
                    file_name: logoname,
                    file_type: logoFile.mimetype || 'image/png',
                    file_path: filename2,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE || 1,
                }, { transaction });

                await rel_sysapp_filesModel.update(
                    { vigente: false, f_no_reg: new Date() },
                    {
                        where: {
                            fk_id_sysapp: idapp,
                            fk_id_cat_type_files: rel_sysapp_filesModel.idCatTypeLogo,
                        },
                        transaction
                    }
                );

                await rel_sysapp_filesModel.create({
                    fk_id_sysapp: idapp,
                    fk_id_file: newFile.id_file,
                    fk_id_cat_type_files: rel_sysapp_filesModel.idCatTypeLogo,
                    vigente: true,
                }, { transaction });
            }
        }

        // Cambio de responsable (edición): revocar permisos del anterior y enlazar al nuevo
        if (idEditNum > 0 && idapp > 0 && Number.isFinite(idResponsable)) {
            const { QueryTypes } = require('sequelize');
            const nuevoRespId = idResponsable;
            const oldRows = await dbConection.query(
                `SELECT u.id_user AS id_user
                 FROM sysapp_user_perm sup
                 INNER JOIN users u ON u.id_user = sup.fk_id_user
                 INNER JOIN cat_type_users ct ON ct.id_cat_type_users = u.fk_id_cat_type_users
                 WHERE sup.fk_id_sysapp = $1::integer AND (sup.activo IS NOT FALSE)
                   AND LOWER(COALESCE(ct.type_user, '')) LIKE '%responsable%'
                 ORDER BY sup.fecha_asignacion DESC NULLS LAST
                 LIMIT 1`,
                { bind: [idapp], type: QueryTypes.SELECT, transaction }
            );
            const oldRespId = oldRows?.[0]?.id_user != null ? parseInt(oldRows[0].id_user, 10) : null;

            if (oldRespId !== nuevoRespId) {
                const mismoNombreDb =
                    String(process.env.PGDB_NAME || '') === String(process.env.PGDB_NAME_MAIN || '');
                const revokeSql = `UPDATE sys_perm SET vigente = false, f_revoca = NOW()
                     WHERE fk_id_user = $1::integer AND fk_id_sysapp = $2::integer AND (vigente IS NOT FALSE)`;

                if (oldRespId != null && Number.isFinite(oldRespId)) {
                    await dbConection.query(
                        `DELETE FROM sysapp_user_perm
                         WHERE fk_id_sysapp = $1::integer AND fk_id_user = $2::integer`,
                        { bind: [idapp, oldRespId], type: QueryTypes.DELETE, transaction }
                    );
                    await pgCatalog.query(revokeSql, { bind: [oldRespId, idapp], type: QueryTypes.UPDATE });
                    if (!mismoNombreDb) {
                        await dbConection.query(revokeSql, { bind: [oldRespId, idapp], type: QueryTypes.UPDATE, transaction });
                    }
                }

                const existNuevo = await dbConection.query(
                    `SELECT id_sysapp_user_perm FROM sysapp_user_perm
                     WHERE fk_id_sysapp = $1::integer AND fk_id_user = $2::integer LIMIT 1`,
                    { bind: [idapp, nuevoRespId], type: QueryTypes.SELECT, transaction }
                );
                if (existNuevo && existNuevo.length) {
                    await dbConection.query(
                        `UPDATE sysapp_user_perm SET activo = true, fecha_asignacion = NOW(), fecha_revocacion = NULL
                         WHERE fk_id_sysapp = $1::integer AND fk_id_user = $2::integer`,
                        { bind: [idapp, nuevoRespId], type: QueryTypes.UPDATE, transaction }
                    );
                } else {
                    await sysapp_user_permModel.create({
                        fk_id_sysapp: idapp,
                        fk_id_user: nuevoRespId,
                        activo: true,
                        fecha_asignacion: new Date(),
                    }, { transaction });
                }

                idUserParaSyncPostCommit = nuevoRespId;
            }
        }

        // Insertar los otros registros necesarios sólo en alta
        if (idEditNum === 0) {
            await rel_sysapp_groupModel.create(
                {
                    fk_id_sysapp: idapp,
                    fk_id_sysapp_group: grupoAppId
                },
                { transaction }
            );

            // Dar acceso a la nueva instancia: usuario que crea
            await sysapp_user_permModel.create({
                fk_id_sysapp: idapp,
                fk_id_user: req.usdata.id_user,
                activo: true,
                fecha_asignacion: new Date(),
            }, { transaction });

            if (crearResponsableNuevo) {
                const typeResponsable = await ensureResponsibleTypeId({ transaction });
                if (!Number.isFinite(typeResponsable)) {
                    throw new Error('No existe tipo de usuario configurado para Responsable de instancia.');
                }
                const correoResponsable = String(responsable_email || '').trim().toLowerCase();
                const curpResponsable = String(responsable_curp || '').trim().toUpperCase();
                const fkEstadoResp = parseInt(responsable_fk_id_estado, 10);

                const resolucion = await resolverResponsableExistenteSinCms({
                    transaction,
                    correoResponsable,
                    curpResponsable,
                });

                if (resolucion.mode === 'reuse') {
                    idResponsable = resolucion.id_user;
                    responsableIncluyePasswordTemporal = false;
                    await dbConection.query(
                        `UPDATE users SET
                            fk_id_cat_type_users = $2::integer,
                            nombre = $3,
                            primer_apellido = $4,
                            segundo_apellido = $5,
                            email = $6,
                            uname = $6,
                            curp = $7,
                            fk_id_estado = $8::integer
                         WHERE id_user = $1::integer`,
                        {
                            bind: [
                                idResponsable,
                                typeResponsable,
                                String(responsable_nombre || '').trim(),
                                String(responsable_primer_apellido || '').trim(),
                                String(responsable_segundo_apellido || '').trim(),
                                correoResponsable,
                                curpResponsable,
                                fkEstadoResp,
                            ],
                            type: require('sequelize').QueryTypes.UPDATE,
                            transaction,
                        }
                    );
                    logCI('responsable: usuario existente sin CMS, reutilizado', { idResponsable });
                    try {
                        const cmsRolId = await usersMainModel.resolveCmsRoleIdByCatTypeUsers(typeResponsable);
                        if (cmsRolId != null && Number.isFinite(cmsRolId)) {
                            await usersMainModel.applyCmsRoleAccess(idResponsable, cmsRolId, {
                                inTransaction: true,
                            });
                        }
                    } catch (eRol) {
                        console.warn('[CreateInst] applyCmsRoleAccess responsable reutilizado:', eRol?.message || eRol);
                    }
                } else {
                    const passtemp = genCode();
                    const saltRounds = 10;
                    const salt = bcrypt.genSaltSync(saltRounds);
                    const hashedPass = bcrypt.hashSync(passtemp, salt);
                    tempPasswordResponsable = passtemp;
                    responsableIncluyePasswordTemporal = true;
                    const nuevoResponsable = await dbConection.query(
                        `INSERT INTO users (
                            uname, upass, fk_id_cat_type_users, nombre, primer_apellido, segundo_apellido,
                            email, curp, fk_id_estado, campass, activo, vigente
                         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,true,true)
                         RETURNING id_user`,
                        {
                            bind: [
                                correoResponsable,
                                hashedPass,
                                typeResponsable,
                                String(responsable_nombre || '').trim(),
                                String(responsable_primer_apellido || '').trim(),
                                String(responsable_segundo_apellido || '').trim(),
                                correoResponsable,
                                curpResponsable,
                                fkEstadoResp,
                            ],
                            type: require('sequelize').QueryTypes.SELECT,
                            transaction,
                        }
                    );
                    idResponsable = nuevoResponsable?.[0]?.id_user;
                }
            }

            if (Number.isFinite(idResponsable)) {
                const mismoQueCreador = Number(idResponsable) === Number(req.usdata.id_user);
                if (!mismoQueCreador) {
                    await sysapp_user_permModel.create({
                        fk_id_sysapp: idapp,
                        fk_id_user: idResponsable,
                        activo: true,
                        fecha_asignacion: new Date(),
                    }, { transaction });
                    logCI('sysapp_user_perm creado para responsable', { idResponsable, idapp });
                } else {
                    logCI('responsable = creador: un solo sysapp_user_perm (ya enlazado al crear)', {
                        idResponsable,
                        idapp,
                    });
                }
            }

            // Configuración de módulos
            const configuracionModulosPrincipales = {
                'Menú': {
                    fk_id_ruta: 10,
                    smicon: '/assets/img/menu/MENU_LOGO.svg'
                },
                'Documentos': {
                    fk_id_ruta: 11,
                    smicon: '/assets/img/menu/USUARIOS.svg'
                },
                'Páginas': {
                    fk_id_ruta: 2,
                    smicon: '/assets/img/menu/USUARIOS.svg'
                },
            };

            const configuracionModulosSecundarios = {
                'Menú': {
                    fk_id_ruta: 10,
                    smicon: '/assets/img/menu/MENU_LOGO.svg',
                    moduloPrincipal: 'Menú',
                },
                'Páginas': {
                    fk_id_ruta: 2,
                    smicon: '/assets/img/menu/USUARIOS.svg',
                    moduloPrincipal: 'Páginas',
                },
                'Documentos': {
                    fk_id_ruta: 11,
                    smicon: '/assets/img/menu/USUARIOS.svg',
                    moduloPrincipal: 'Documentos',
                },
                'Imágenes': {
                    fk_id_ruta: 13,
                    smicon: '/assets/img/menu/USUARIOS.svg',
                    moduloPrincipal: 'Documentos',
                },
            };

            const modulosParaCrear = Object.keys(configuracionModulosPrincipales);
            let orderModInicial = 1;

            for (const nombreModulo of modulosParaCrear) {
                const config = configuracionModulosPrincipales[nombreModulo];

                // 1. Buscamos si el módulo principal ya existe
                let busquedaModulo = await modulosModel.findOne({
                    where: {
                        fk_id_sysapp_group: grupoAppId,
                        fk_id_sysapp_type: 3,
                        modulo: nombreModulo
                    },
                    order: [['id_sysmod', 'ASC']],
                    raw: true,
                    transaction
                });

                if (!busquedaModulo) {
                    busquedaModulo = await modulosModel.create({
                        fk_id_sysapp_group: grupoAppId,
                        modulo: nombreModulo,
                        modulo_legend: nombreModulo,
                        order_mod: orderModInicial,
                        fk_id_sysapp_type: 3,
                    }, { transaction });
                }

                // 2. Submódulos secundarios asociados al módulo principal actual
                const submodulosSecundarios = Object.entries(configuracionModulosSecundarios)
                    .filter(([_, submodulo]) => submodulo.moduloPrincipal === nombreModulo)
                    .map(([key, submodulo]) => ({
                        nombre: key,
                        ...submodulo
                    }));

                for (const submod of submodulosSecundarios) {
                    let busquedaSubModulo = await sub_moduloModel.findOne({
                        where: {
                            submodulo: submod.nombre,
                            fk_id_ruta: { [Op.ne]: null },
                            fk_id_sysmod: busquedaModulo.id_sysmod
                        },
                        order: [['id_syssubmod', 'ASC']],
                        raw: true,
                        transaction
                    });

                    if (!busquedaSubModulo) {
                        busquedaSubModulo = await sub_moduloModel.create({
                            fk_id_sysmod: busquedaModulo.id_sysmod,
                            submodulo: submod.nombre,
                            submodulo_legend: submod.nombre,
                            smicon: submod.smicon || config.smicon,
                            order_submod: orderModInicial,
                            fk_id_ruta: submod.fk_id_ruta ?? config.fk_id_ruta
                        }, { transaction });
                    }

                    await sys_permModel.create({
                        fk_id_user: req.usdata.id_user,
                        fk_id_syssubmod: busquedaSubModulo.id_syssubmod,
                        fk_id_sysapp: idapp,
                    }, { transaction });

                    orderModInicial++;
                }
                orderModInicial++;
            }

            // sys_perm del responsable en catálogo: syncResponsableSysPermAfterCreate (pre-commit si PGDB_NAME=PGDB_NAME_MAIN).
        }

        if (idEditNum === 0 && Number.isFinite(idResponsable) && idapp > 0) {
            idUserParaSyncPostCommit = idResponsable;
        }

        if (catalogDbIsSameAsMain() && Number.isFinite(idUserParaSyncPostCommit) && idapp > 0) {
            logCI('syncResponsableSysPermAfterCreate (pre-commit, catálogo=main)', {
                idResponsable: idUserParaSyncPostCommit,
                idapp,
                fkType
            });
            await syncResponsableSysPermAfterCreate({
                idResponsable: idUserParaSyncPostCommit,
                idSysapp: idapp,
                fkType,
                logCI,
                sequelize: dbConection,
                transaction
            });
        }

        /** Bitácora en la misma BD que main → si falla, hace rollback de toda la transacción de alta. */
        if (catalogDbIsSameAsMain() && idEditNum === 0 && req.usdata && req.usdata.id_user && idapp > 0) {
            await registraBitacoraInsert(
                dbConection,
                {
                    fk_id_user_actor: req.usdata.id_user,
                    accion: BITACORA.INSTANCIA_ALTA,
                    fk_id_sysapp: idapp,
                    detalle: {
                        sysapp_name: namepag,
                        urluri: fullUrl,
                        fk_id_sysapp_type: fkType,
                    },
                    req,
                },
                { transaction }
            );
            if (Number.isFinite(idResponsable)) {
                await registraBitacoraInsert(
                    dbConection,
                    {
                        fk_id_user_actor: req.usdata.id_user,
                        accion: BITACORA.RESPONSABLE_INSTANCIA_ALTA,
                        fk_id_sysapp: idapp,
                        fk_id_user_afectado: idResponsable,
                        detalle: {
                            crear_usuario_nuevo: crearResponsableNuevo,
                            sysapp_name: namepag,
                        },
                        req,
                    },
                    { transaction }
                );
            }
        }

        await transaction.commit();
        transactionCommitted = true;
        logCI('COMMIT transacción principal ok', { idapp, idResponsable, fkType, idUserParaSyncPostCommit });

        /** Catálogo en otra BD: bitácora solo después del COMMIT; si falla, revertimos el alta en main. */
        if (!catalogDbIsSameAsMain() && idEditNum === 0 && req.usdata && req.usdata.id_user && idapp > 0) {
            try {
                await registraBitacoraInsert(
                    pgCatalog,
                    {
                        fk_id_user_actor: req.usdata.id_user,
                        accion: BITACORA.INSTANCIA_ALTA,
                        fk_id_sysapp: idapp,
                        detalle: {
                            sysapp_name: namepag,
                            urluri: fullUrl,
                            fk_id_sysapp_type: fkType,
                        },
                        req,
                    },
                    {}
                );
                if (Number.isFinite(idResponsable)) {
                    await registraBitacoraInsert(
                        pgCatalog,
                        {
                            fk_id_user_actor: req.usdata.id_user,
                            accion: BITACORA.RESPONSABLE_INSTANCIA_ALTA,
                            fk_id_sysapp: idapp,
                            fk_id_user_afectado: idResponsable,
                            detalle: {
                                crear_usuario_nuevo: crearResponsableNuevo,
                                sysapp_name: namepag,
                            },
                            req,
                        },
                        {}
                    );
                }
            } catch (eBit) {
                console.error('[CreateInst] bitácora obligatoria falló; revirtiendo alta.', eBit);
                try {
                    await revertirAltaInstanciaPorFalloBitacora({
                        idapp,
                        idResponsable,
                        crearResponsableNuevo,
                    });
                } catch (eRev) {
                    console.error('[CreateInst] error al revertir alta tras fallo de bitácora:', eRev);
                }
                await reloadGlobalCatAppsActivas();
                return res.status(500).json({
                    success: false,
                    error: 1,
                    message:
                        'No se pudo registrar la operación en bitácora de auditoría. La creación de la instancia se revirtió. Intenta de nuevo o contacta al administrador.',
                });
            }
        }

        if (!catalogDbIsSameAsMain() && Number.isFinite(idUserParaSyncPostCommit) && idapp > 0) {
            const { QueryTypes } = require('sequelize');
            try {
                const cntCat = await pgCatalog.query(
                    `SELECT COUNT(*)::int AS n
                     FROM sys_perm
                     WHERE fk_id_user = $1::integer
                       AND fk_id_sysapp = $2::integer
                       AND (vigente IS NOT FALSE)`,
                    { bind: [idUserParaSyncPostCommit, idapp], type: QueryTypes.SELECT }
                );
                logCI('tras commit: filas sys_perm (postgressdb) responsable+instancia', cntCat?.[0]);
            } catch (eCnt) {
                logCI('no se pudo contar sys_perm en catálogo tras commit', eCnt?.message || eCnt);
            }
            logCI('syncResponsableSysPermAfterCreate (post-commit, BDs distintas)', {
                idResponsable: idUserParaSyncPostCommit,
                idapp,
                fkType
            });
            try {
                await syncResponsableSysPermAfterCreate({
                    idResponsable: idUserParaSyncPostCommit,
                    idSysapp: idapp,
                    fkType,
                    logCI
                });
            } catch (errGrant) {
                console.error('[CreateInst] syncResponsableSysPermAfterCreate (post-commit):', errGrant);
                return res.status(500).json({
                    success: false,
                    error: 1,
                    message:
                        'La instancia se registró pero no se pudieron aplicar los permisos del responsable. Contacta al administrador.'
                });
            }
        }

        if (idEditNum === 0 && idapp > 0) {
            try {
                await createDefaultTemplates(idapp, req.usdata.id_user);
            } catch (errTpl) {
                console.error('[CreateInst] Error creando plantillas por defecto:', errTpl?.message || errTpl);
                if (errTpl?.stack) console.error(errTpl.stack);
            }

            if (Number.isFinite(idResponsable)) {
                try {
                    const responsableRows = await dbConection.query(
                        `SELECT id_user, nombre, primer_apellido, segundo_apellido, email
                         FROM users
                         WHERE id_user = $1::integer
                         LIMIT 1`,
                        {
                            bind: [idResponsable],
                            type: require('sequelize').QueryTypes.SELECT
                        }
                    );
                    const responsable = responsableRows?.[0];
                    if (responsable?.email) {
                        const appBaseUrl = process.env.APP_BASE_URL != '' ? process.env.APP_BASE_URL : 'morena.org';
                        const imagePathTop = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_2.png');
                        const imagePathBottom = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_1.jpg');
                        const nombreDestino = [responsable.nombre, responsable.primer_apellido, responsable.segundo_apellido].filter(Boolean).join(' ');
                        const bloqueAcceso = responsableIncluyePasswordTemporal
                            ? `<p style="color:#333; font-size:15px; text-align:center; line-height:1.6; margin:15px 0;">Sus datos de inicio de sesión son:</p>
                               <div style="background-color:#f5f5f5; border:2px solid #B38E5D; border-radius:8px; padding:20px; margin:20px auto; max-width:450px;">
                                   <p style="margin:10px 0; font-weight:700; font-size:1rem; color:#235b4e;">USUARIO:</p>
                                   <p style="margin:5px 0; font-size:1.1rem; color:#000;">${responsable.email}</p>
                                   <p style="margin:15px 0 10px 0; font-weight:700; font-size:1rem; color:#235b4e;">CONTRASEÑA TEMPORAL:</p>
                                   <p style="margin:5px 0; font-size:1.3rem; font-weight:800; color:#8b1e1e;">${tempPasswordResponsable || 'Revise con administrador'}</p>
                               </div>`
                            : `<p style="margin:20px 0; font-size:15px; color:#333; text-align:center;">Ya cuentas con usuario registrado. Ingresa con los accesos que ya tenías.</p>`;
                        const body = `<html>
                            <body style="margin:0; padding:0; text-align:center;">
                                <div style="max-width:800px; margin:0 auto; text-align:center;">
                                    <img src="cid:topImage" style="width:100%; max-width:800px; display:block;">
                                    <div style="max-width:600px; margin:0 auto; padding:30px 20px; font-family:Montserrat, Arial, sans-serif; color:#021B23; text-align:center;">
                                        <h2 style="font-weight:800; color:#235b4e; margin:20px 0; font-size:1.6rem;">ASIGNACIÓN DE INSTANCIA CMS</h2>
                                        <hr style="border:none; height:3px; width:120px; background-color:#B38E5D; margin:10px auto 25px auto;">
                                        ${bloqueAcceso}
                                        <p style="color:#333; font-size:15px; text-align:center; line-height:1.6; margin:10px 0 4px;">Se te asignó la siguiente instancia:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; font-weight:700; color:#000;">${namepag}</p>
                                        <p style="margin:5px 0; font-size:0.95rem; color:#555;">Dominio de la instancia: ${fullUrl}</p>
                                        <p style="margin:20px 0; font-size:15px; color:#333; text-align:center;">Puedes ingresar al sistema desde:</p>
                                        <p style="margin:20px 0; text-align:center;">
                                            <a href="https://${appBaseUrl}/" style="display:inline-block; background-color:#b91c1c; color:#ffffff; font-weight:700; text-decoration:none; font-size:16px; padding:12px 28px; border-radius:6px; font-family:Montserrat, Arial, sans-serif;">Ingresa aquí</a>
                                        </p>
                                    </div>
                                    <img src="cid:bottomImage" style="width:100%; max-width:800px; display:block;">
                                </div>
                            </body>
                        </html>`;
                        const mailRes = await enviarEmail({
                            to: responsable.email,
                            to_name: nombreDestino || 'Usuario',
                            subject: `[CMS Morena] Asignación de instancia: ${namepag}`,
                            body,
                            isHTml: true,
                            attachments: [
                                { path: imagePathTop, filename: 'FIRMA_CORREO_MORENA_2.png', type: 'image/png', disposition: 'inline', cid: 'topImage' },
                                { path: imagePathBottom, filename: 'FIRMA_CORREO_MORENA_1.jpg', type: 'image/jpeg', disposition: 'inline', cid: 'bottomImage' }
                            ]
                        });
                        if (!mailRes || mailRes.success !== true) {
                            correoResponsableOk = false;
                            logCI('correo al responsable no enviado', mailRes?.msg || mailRes);
                        }
                    }
                } catch (errMail) {
                    correoResponsableOk = false;
                    console.error('[CreateInst] Error enviando correo al responsable:', errMail?.message || errMail);
                }
            }
        }

        await reloadGlobalCatAppsActivas();

        let mensajeOk =
            idEditNum > 0 ? 'Se actualizó la instancia correctamente' : 'Se creó la instancia solicitada';
        if (idEditNum === 0 && !correoResponsableOk) {
            mensajeOk +=
                ' Aviso: no se pudo enviar el correo al responsable (por ejemplo API key de SendGrid inválida o MAIL_ACTIVE). La instancia sí quedó registrada.';
        }
        return res.status(200).json({ success: true, message: mensajeOk });
    } catch (error) {
        try {
            if (!transactionCommitted) {
                await transaction.rollback();
            }
        } catch (rbErr) {
            console.error('[CreateInst] rollback', rbErr);
        }
        const msg = String(error?.message || '');
        console.error(
            '[CreateInst] detalle:',
            error?.name,
            msg,
            Array.isArray(error?.errors) ? error.errors : error?.parent?.message || ''
        );
        if (msg.includes('USUARIO_YA_REGISTRADO_CMS:')) {
            return res.status(400).json({
                success: false,
                error: 1,
                message: msg.replace(/^USUARIO_YA_REGISTRADO_CMS:\s*/, ''),
            });
        }
        if (msg.includes('No existe tipo de usuario configurado')) {
            return res.status(500).json({
                success: false,
                error: 1,
                message: 'Falta configurar el tipo de usuario «Responsable de instancia» en el sistema. Contacta al administrador.'
            });
        }
        return responderErrorInterno(res, error, '[CreateInst]');
    }
}

async function DeleteInst(req, res){
    try{
        let id = req.query.p;
        const idNum = parseInt(id, 10);

        const instancia = await sysappModel.findOne({ where: { id_sysapp: idNum }, raw: true });
        const hosting = await HostingModel.findOne({ where: { fk_id_sysapp: idNum }, raw: true });
        const nombreSolicitante = req.usdata.nombre
            ? [req.usdata.nombre, req.usdata.primer_apellido, req.usdata.segundo_apellido].filter(Boolean).join(' ')
            : 'Usuario';

        if (!instancia) {
            return res.status(404).json({ success: false, message: 'Instancia no encontrada' });
        }

        // Regla de negocio:
        // - Si la instancia NO está publicada: se puede eliminar (como hoy).
        // - Si SÍ está publicada: NO se puede eliminar hasta que Hosting procese la baja del dominio.
        //   Flujo: estatus 2 (con dominio) -> solicitar baja (4) -> baja procesada (5) -> eliminar instancia.
        if (instancia.publicada === true) {
            const est = hosting?.fk_id_estatus_hosting != null ? parseInt(hosting.fk_id_estatus_hosting, 10) : null;
            if (est !== 5) {
                return res.status(400).json({
                    success: false,
                    message: 'No se puede eliminar una instancia publicada. Primero solicite y procese la baja del dominio en el módulo de Hosting. Cuando el estatus sea "Baja procesada", podrá eliminarla.'
                });
            }
        }

        await sysappModel.update(
            { vigente: false },
            { where: { id_sysapp: idNum } }
        );

        const destino = process.env.INFRA_MAIL || process.env.MAIL_ORIGIN || '';
        if (destino && instancia) {
            const imagePathTop = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_2.png');
            const imagePathBottom = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_1.jpg');
            const bodyInfra = `<html>
                        <body style="margin:0; padding:0; text-align:center;">
                            <div style="max-width:800px; margin:0 auto; text-align:center;">
                                <img src="cid:topImage" style="width:100%; max-width:800px; display:block;">
                                <div style="max-width:600px; margin:0 auto; padding:30px 20px; font-family:Montserrat, Arial, sans-serif; color:#021B23; text-align:center;">
                                    <h2 style="font-weight:800; color:#8e2c2d; margin:20px 0; font-size:1.8rem;">BAJA DE INSTANCIA SOLICITADA</h2>
                                    <hr style="border:none; height:3px; width:120px; background-color:#8e2c2d; margin:10px auto 25px auto;">
                                    <p style="color:#333; font-size:15px; text-align:center; line-height:1.6; margin:25px 0;">El usuario solicita dar de baja esta instancia y, en su caso, el dominio asociado.</p>
                                    <div style="background-color:#f5f5f5; border:2px solid #8e2c2d; border-radius:8px; padding:20px; margin:25px auto; max-width:450px; text-align:left;">
                                        <p style="margin:10px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Instancia:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${instancia.sysapp_name}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Dominio/URL:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${instancia.urluri || 'N/A'}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Solicitante:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${nombreSolicitante}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Fecha:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${new Date().toLocaleString('es-MX')}</p>
                                    </div>
                                </div>
                                <img src="cid:bottomImage" style="width:100%; max-width:800px; display:block;">
                            </div>
                        </body>
                    </html>`;
            await enviarEmail({
                to: destino,
                to_name: 'Infraestructura Tecnológica',
                subject: `[CMS Morena] Baja de instancia solicitada: ${instancia.sysapp_name}`,
                body: bodyInfra,
                isHTml: true,
                attachments: [
                    { path: imagePathTop, filename: 'FIRMA_CORREO_MORENA_2.png', type: 'image/png', disposition: 'inline', cid: 'topImage' },
                    { path: imagePathBottom, filename: 'FIRMA_CORREO_MORENA_1.jpg', type: 'image/jpeg', disposition: 'inline', cid: 'bottomImage' }
                ]
            });
        }

        res.status(200).json({ success: true, message: 'Instancia eliminada' });
    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
async function PubInst(req, res){
    try{
        let id=req.query.p;
        let stat=req.query.stat;
        let pubval=parseInt(stat) !== 1;

        if (pubval) {
            const hosting = await HostingModel.findOne({
                where: { fk_id_sysapp: id, fk_id_estatus_hosting: 2 }
            });
            if (!hosting) {
                return res.status(400).json({
                    success: false,
                    message: 'No se puede publicar: la instancia no tiene dominio asignado. Solicite el dominio al área de Infraestructura Tecnológica.'
                });
            }
        }

        await sysappModel.update(
            {
                publicada: pubval
            },
            {
                where: {
                    id_sysapp: id
                }
            }
        );

        // Generar o eliminar HTML estático para todas las páginas de la instancia
        try {
            const staticGenerator = require('../util/staticGenerator');
            const { pagina } = require('../models/paginasModel');
            
            // Obtener objapp desde catálogo global
            let objapp = null;
            if (global.catalogos && global.catalogos.cat_apps_activas) {
                objapp = global.catalogos.cat_apps_activas.find(
                    app => app.id_sysapp === id
                );
            }

            if (objapp) {
                // Obtener todas las páginas publicadas de esta app
                const paginasPublicadas = await pagina.findAll({
                    where: {
                        fk_id_sysapp: id,
                        vigente: true,
                        publicada: true
                    },
                    raw: true
                });

                if (pubval) {
                    // Publicar: generar HTML estático para todas las páginas
                    for (const pag of paginasPublicadas) {
                        try {
                            const tipoPagina = Number(pag.fk_id_cat_type_pagina) || 0;
                            if (tipoPagina === 5) {
                                const detalleResult = await staticGenerator.generateAndSaveStaticHTMLForEntradaDetalle(
                                    objapp,
                                    pag.id_wb_pagina,
                                    pag.url_safe
                                );
                                if (detalleResult) {
                                    console.log(`✅ HTML estático generado para entrada ${pag.id_wb_pagina}`);
                                }
                            } else {
                                await staticGenerator.generateAndSaveStaticHTML(
                                    objapp,
                                    pag,
                                    pag.url_safe || '/',
                                    pag.fk_id_cat_type_pagina || 2
                                );
                                console.log(`✅ HTML estático generado para página ${pag.id_wb_pagina}`);
                            }
                        } catch (pageError) {
                            console.error(`❌ Error generando HTML para página ${pag.id_wb_pagina}:`, pageError);
                        }
                    }
                    // Páginas virtuales: "VER TODAS LAS NOTICIAS" (entradas.html) y "VER TODOS LOS PERIODICOS" (regeneracion.html)
                    try {
                        await staticGenerator.generateAndSaveStaticHTMLForEntradasList(objapp);
                        console.log('✅ HTML estático generado: entradas.html');
                    } catch (e) {
                        console.error('❌ Error generando entradas.html:', e);
                    }
                    try {
                        await staticGenerator.generateAndSaveStaticHTMLForRegeneracion(objapp);
                        console.log('✅ HTML estático generado: regeneracion.html');
                    } catch (e) {
                        console.error('❌ Error generando regeneracion.html:', e);
                    }
                } else {
                    // Despublicar: eliminar HTML estático de todas las páginas
                    for (const pag of paginasPublicadas) {
                        try {
                            const tipoPagina = Number(pag.fk_id_cat_type_pagina) || 0;
                            if (tipoPagina === 5) {
                                await staticGenerator.deleteStaticHTMLVirtual(objapp, 'entrada_' + pag.id_wb_pagina);
                                console.log(`🗑️ HTML estático eliminado para entrada ${pag.id_wb_pagina}`);
                            } else {
                                await staticGenerator.deleteStaticHTML(
                                    objapp,
                                    pag,
                                    pag.url_safe || '/'
                                );
                                console.log(`🗑️ HTML estático eliminado para página ${pag.id_wb_pagina}`);
                            }
                        } catch (pageError) {
                            console.error(`❌ Error eliminando HTML para página ${pag.id_wb_pagina}:`, pageError);
                        }
                    }
                    // Eliminar páginas virtuales
                    try {
                        await staticGenerator.deleteStaticHTMLVirtual(objapp, 'entradas_list');
                        await staticGenerator.deleteStaticHTMLVirtual(objapp, 'regeneracion');
                        console.log('🗑️ HTML estático eliminado: entradas.html, regeneracion.html');
                    } catch (e) {
                        console.error('❌ Error eliminando páginas virtuales:', e);
                    }
                }
            }
        } catch (staticError) {
            console.error('Error generando/eliminando HTML estático:', staticError);
            // No fallar la publicación si hay error en estático
        }

        res.status(200).json({ success: true, message: 'Página cambió estatus de publicación' });

    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

/** Marcar instancia como "páginas completadas" (habilita solicitar dominio). Requiere estatus 0=PENDIENTE en cat_estatus_hosting. */
async function marcarPaginasCompletadas(req, res) {
    try {
        const { id_sysapp } = req.body;
        const idapp = parseInt(id_sysapp, 10);
        if (!idapp) return res.status(400).json({ success: false, message: 'ID de instancia inválido' });

        const instancia = await sysappModel.findOne({ where: { id_sysapp: idapp, vigente: true } });
        if (!instancia) return res.status(404).json({ success: false, message: 'Instancia no encontrada' });

        const dominioPendiente = normalizeRequestedDomain(instancia.urluri) || 'pendiente';

        const [hosting, created] = await HostingModel.findOrCreate({
            where: { fk_id_sysapp: idapp },
            defaults: {
                fk_id_sysapp: idapp,
                fk_id_estatus_hosting: 0,
                dominio_solicitado: dominioPendiente,
                solicitado_por: req.usdata.id_user,
                f_solicitud: new Date(),
                paginas_completadas: true,
                f_paginas_completadas: new Date()
            }
        });

        if (!created && hosting.fk_id_estatus_hosting !== 1 && hosting.fk_id_estatus_hosting !== 2) {
            await hosting.update({
                paginas_completadas: true,
                f_paginas_completadas: new Date()
            });
        }

        return res.json({ success: true, message: 'Instancia marcada como completada' });
    } catch (error) {
        return responderErrorInterno(res, error, '[marcarPaginasCompletadas]');
    }
}

/**
 * Solicitar dominio: validación rápida y encolado en segundo plano (evita timeout de proxy en la generación larga).
 * El cliente consulta GET /solicitarDominio/status/:jobId hasta que termine.
 */
async function solicitarDominio(req, res) {
    try {
        const { id_sysapp } = req.body;
        const idapp = parseInt(id_sysapp, 10);
        if (!idapp) return res.status(400).json({ success: false, message: 'ID de instancia inválido' });

        const instancia = await sysappModel.findOne({ where: { id_sysapp: idapp, vigente: true } });
        if (!instancia) return res.status(404).json({ success: false, message: 'Instancia no encontrada' });

        const dominio = normalizeRequestedDomain(instancia.urluri);
        if (!dominio) return res.status(400).json({ success: false, message: 'Configure el dominio deseado en la instancia antes de solicitar' });

        const hosting = await HostingModel.findOne({ where: { fk_id_sysapp: idapp } });
        if (hosting) {
            if (hosting.fk_id_estatus_hosting === 1) {
                return res.status(400).json({ success: false, message: 'Ya existe una solicitud de dominio pendiente' });
            }
            if (hosting.fk_id_estatus_hosting === 2) {
                return res.status(400).json({ success: false, message: 'La instancia ya tiene dominio asignado' });
            }
            if (hosting.fk_id_estatus_hosting === 4 || hosting.fk_id_estatus_hosting === 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Esta instancia tiene una baja de dominio solicitada/procesada. No es posible generar una nueva solicitud.'
                });
            }
        }

        limpiarSolicitarDominioJobsExpirados();
        if (solicitarDominioLocksPorInstancia.has(idapp)) {
            return res.status(409).json({
                success: false,
                message: 'Ya hay una generación en curso para esta instancia. Espere a que termine o recargue la página.'
            });
        }

        const jobId = crypto.randomUUID();
        const id_user = req.usdata.id_user;
        solicitarDominioJobs.set(jobId, {
            status: 'pending',
            id_user,
            id_sysapp: idapp,
            startedAt: Date.now()
        });
        solicitarDominioLocksPorInstancia.add(idapp);

        setImmediate(() => {
            runSolicitarDominioJob(jobId, id_user, idapp);
        });

        return res.json({
            success: true,
            async: true,
            jobId,
            message: 'Procesando solicitud…'
        });
    } catch (error) {
        return responderErrorInterno(res, error, '[solicitarDominio]');
    }
}

/** Polling del trabajo de solicitar dominio (peticiones cortas, sin límite de tiempo acumulado en una sola HTTP). */
async function solicitarDominioStatus(req, res) {
    try {
        const jobId = req.params.jobId;
        if (!jobId || typeof jobId !== 'string') {
            return res.status(400).json({ success: false, message: 'Solicitud inválida' });
        }
        let job = solicitarDominioJobs.get(jobId);
        if (!job) {
            const idSysappQ = req.query.id_sysapp != null ? parseInt(String(req.query.id_sysapp), 10) : null;
            if (idSysappQ) {
                const recuperado = await recuperarEstadoSolicitarDominioDesdeDb(req.usdata.id_user, idSysappQ);
                if (recuperado) {
                    return res.json(recuperado);
                }
            }
            return res.status(404).json({
                success: false,
                message: 'No se encontró el proceso. Puede haber expirado; intente de nuevo.'
            });
        }
        if (Number(job.id_user) !== Number(req.usdata.id_user)) {
            return res.status(403).json({ success: false, message: 'No autorizado' });
        }
        if (job.status === 'pending' || job.status === 'running') {
            return res.json({ success: true, pending: true, status: job.status });
        }
        return res.json({
            success: true,
            pending: false,
            done: true,
            result: { success: job.success, message: job.message || '' }
        });
    } catch (error) {
        return responderErrorInterno(res, error, '[solicitarDominioStatus]');
    }
}

/** Solicitar baja de dominio: marca hosting como BAJA_SOLICITADA y envía correo a Infra. */
async function solicitarBajaDominio(req, res) {
    try {
        const { id_sysapp } = req.body;
        const idapp = parseInt(id_sysapp, 10);
        if (!idapp) return res.status(400).json({ success: false, message: 'ID de instancia inválido' });

        const hosting = await HostingModel.findOne({ where: { fk_id_sysapp: idapp } });
        if (!hosting) return res.status(404).json({ success: false, message: 'No hay registro de hosting para esta instancia' });
        if (hosting.fk_id_estatus_hosting !== 2) return res.status(400).json({ success: false, message: 'Solo se puede solicitar baja de instancias con dominio asignado' });

        await hosting.update({
            fk_id_estatus_hosting: 4,
            f_baja_solicitada: new Date()
        });

        const instancia = await sysappModel.findOne({ where: { id_sysapp: idapp } });
        const solicitante = await usersModel.findOne({ where: { id_user: req.usdata.id_user }, raw: true });
        const nombreSolicitante = solicitante ? [solicitante.nombre, solicitante.primer_apellido, solicitante.segundo_apellido].filter(Boolean).join(' ') : 'Usuario';

        const staticGenerator = require('../util/staticGenerator');
        let objappBaja = null;
        if (global.catalogos && global.catalogos.cat_apps_activas) {
            objappBaja = global.catalogos.cat_apps_activas.find((app) => app.id_sysapp === idapp);
        }
        const instPlainBaja = instancia?.get ? instancia.get({ plain: true }) : instancia;
        objappBaja = { ...(objappBaja || {}), ...instPlainBaja, id_sysapp: idapp };
        const distDirProduccion = escapeHtmlAttr(staticGenerator.getDistDirBase(idapp, objappBaja));

        const destino = process.env.INFRA_MAIL || process.env.MAIL_ORIGIN || '';
        if (destino) {
            const imagePathTop = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_2.png');
            const imagePathBottom = path.join(__dirname, '../public/assets/avisos/FIRMA_CORREO_MORENA_1.jpg');
            const dominioActual = hosting.dominio_asignado || hosting.dominio_solicitado || 'N/A';
            const bodyInfra = `<html>
                        <body style="margin:0; padding:0; text-align:center;">
                            <div style="max-width:800px; margin:0 auto; text-align:center;">
                                <img src="cid:topImage" style="width:100%; max-width:800px; display:block;">
                                <div style="max-width:600px; margin:0 auto; padding:30px 20px; font-family:Montserrat, Arial, sans-serif; color:#021B23; text-align:center;">
                                    <h2 style="font-weight:800; color:#8e2c2d; margin:20px 0; font-size:1.8rem;">BAJA DE DOMINIO SOLICITADA</h2>
                                    <hr style="border:none; height:3px; width:120px; background-color:#8e2c2d; margin:10px auto 25px auto;">
                                    <p style="color:#333; font-size:15px; text-align:center; line-height:1.6; margin:25px 0;">Se solicita dar de baja el dominio de la siguiente instancia del Sistema de Administración de Contenido Institucional.</p>
                                    <div style="background-color:#f5f5f5; border:2px solid #8e2c2d; border-radius:8px; padding:20px; margin:25px auto; max-width:450px; text-align:left;">
                                        <p style="margin:10px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Instancia:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${instancia.sysapp_name}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Dominio actual:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${dominioActual}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Ubicación en servidor (distDir):</p>
                                        <p style="margin:5px 0; font-size:0.95rem; color:#000; word-break:break-all;">${distDirProduccion}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Solicitante:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${nombreSolicitante}</p>
                                        <p style="margin:15px 0 5px 0; font-weight:700; font-size:1rem; color:#8e2c2d;">Fecha:</p>
                                        <p style="margin:5px 0; font-size:1.1rem; color:#000;">${new Date().toLocaleString('es-MX')}</p>
                                    </div>
                                </div>
                                <img src="cid:bottomImage" style="width:100%; max-width:800px; display:block;">
                            </div>
                        </body>
                    </html>`;
            await enviarEmail({
                to: destino,
                to_name: 'Infraestructura Tecnológica',
                subject: `[CMS Morena] Baja de dominio solicitada: ${instancia.sysapp_name}`,
                body: bodyInfra,
                isHTml: true,
                attachments: [
                    { path: imagePathTop, filename: 'FIRMA_CORREO_MORENA_2.png', type: 'image/png', disposition: 'inline', cid: 'topImage' },
                    { path: imagePathBottom, filename: 'FIRMA_CORREO_MORENA_1.jpg', type: 'image/jpeg', disposition: 'inline', cid: 'bottomImage' }
                ]
            });
        }

        return res.json({ success: true, message: 'Solicitud de baja enviada a Infraestructura' });
    } catch (error) {
        return responderErrorInterno(res, error, '[solicitarBajaDominio]');
    }
}

module.exports = {
    instanciasList,
    CreateInst,
    DeleteInst,
    PubInst,
    marcarPaginasCompletadas,
    solicitarDominio,
    solicitarDominioStatus,
    solicitarBajaDominio
}
