/**
 * Bitácora CMS (cat_bitacora_cms + cms_bitacora en la BD indicada; por defecto postgressdb).
 * - `registraBitacora`: best-effort (no rompe la petición).
 * - `registraBitacoraInsert`: para flujos que requieren atomicidad; lanza si falla el INSERT.
 */
const dbCatalogDefault = require('../config/postgressdb');
const { QueryTypes } = require('sequelize');

const accionIdCache = new Map();

/** @param {import('sequelize').Sequelize} sequelize */
function dbCacheKey(sequelize) {
    return sequelize?.config?.database || 'default';
}

const accionColumnCache = new WeakMap();

/** @param {import('sequelize').Sequelize} sequelize */
async function cmsBitacoraTieneColumnaAccion(sequelize) {
    if (!sequelize) sequelize = dbCatalogDefault;
    if (accionColumnCache.has(sequelize)) {
        return accionColumnCache.get(sequelize);
    }
    let result = false;
    try {
        const rows = await sequelize.query(
            `SELECT 1 AS ok
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'cms_bitacora'
               AND column_name = 'accion'
             LIMIT 1`,
            { type: QueryTypes.SELECT }
        );
        result = Array.isArray(rows) && rows.length > 0;
    } catch (_) {
        result = false;
    }
    accionColumnCache.set(sequelize, result);
    return result;
}

const ACCION = {
    INSTANCIA_ALTA: 'instancia_alta',
    /** Nuevo usuario responsable creado al dar de alta una instancia (formulario instancias). */
    RESPONSABLE_INSTANCIA_ALTA: 'responsable_instancia_alta',
    /** Alta de administrador CMS (tipo catálogo 1) desde módulo global /users. */
    USUARIO_ADMIN_CMS_ALTA: 'usuario_admin_cms_alta',
    /** Alta o habilitación de editor (tipo 13), global o por instancia. */
    USUARIO_EDITOR_ALTA: 'usuario_editor_alta',
    /** Baja / revocación de acceso CMS (deActiveUser). */
    USUARIO_CMS_BAJA: 'usuario_cms_baja',
    INICIO_SESION: 'inicio_sesion',
    CIERRE_SESION: 'cierre_sesion',
    PAGINA_ALTA: 'pagina_alta',
    PAGINA_BAJA: 'pagina_baja',
    DOMINIO_SOLICITUD: 'dominio_solicitud',
    DOMINIO_CONFIRMADO: 'dominio_confirmado',
};

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @param {import('sequelize').Transaction} [transaction]
 */
async function obtenerOCrearIdCatBitacora(accion, sequelize, transaction) {
    const clave = String(accion || '').trim().slice(0, 64);
    if (!clave) return null;
    const ck = `${dbCacheKey(sequelize)}::${clave}`;
    if (accionIdCache.has(ck)) return accionIdCache.get(ck);

    const qopts = {
        bind: [clave, `Accion CMS: ${clave}`],
        type: QueryTypes.SELECT,
    };
    if (transaction) qopts.transaction = transaction;

    const rows = await sequelize.query(
        `INSERT INTO cat_bitacora_cms (clave, descripcion, activo)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (clave)
         DO UPDATE SET clave = EXCLUDED.clave
         RETURNING id_cat_bitacora_cms`,
        qopts
    );

    const id = Number(rows?.[0]?.id_cat_bitacora_cms);
    if (!Number.isFinite(id)) return null;

    accionIdCache.set(ck, id);
    return id;
}

/**
 * Inserta en cms_bitacora. Lanza ante error de BD (p. ej. para revertir la operación principal).
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {object} opts
 * @param {object} [execOpts]
 * @param {import('sequelize').Transaction} [execOpts.transaction]
 */
async function registraBitacoraInsert(sequelize, opts, execOpts = {}) {
    const { transaction } = execOpts;
    const {
        fk_id_user_actor,
        accion,
        fk_id_sysapp = null,
        id_wb_pagina = null,
        fk_id_cat_type_pagina = null,
        fk_id_user_afectado = null,
        id_hosting = null,
        detalle = null,
        req = null,
    } = opts || {};

    if (!fk_id_user_actor || !accion) return;

    let detalleJson = null;
    if (detalle != null) {
        try {
            detalleJson = typeof detalle === 'string' ? detalle : JSON.stringify(detalle);
        } catch (_) {
            detalleJson = JSON.stringify({ error: 'detalle_no_serializable' });
        }
    }

    let ip_origen = null;
    if (req) {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            const first = String(xff).split(',')[0].trim();
            if (first) ip_origen = first;
        }
        if (!ip_origen) {
            ip_origen =
                req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null;
        }
        if (ip_origen) ip_origen = String(ip_origen).trim().slice(0, 64);
    }
    const user_agent = (req && req.headers && req.headers['user-agent']) || null;

    const fk_id_cat_bitacora_cms = await obtenerOCrearIdCatBitacora(accion, sequelize, transaction);
    if (!fk_id_cat_bitacora_cms) return;

    const accionLegacy = String(accion || '').trim().slice(0, 64);
    const bindBase = [
        fk_id_user_actor,
        fk_id_cat_bitacora_cms,
        fk_id_sysapp,
        id_wb_pagina,
        fk_id_cat_type_pagina,
        fk_id_user_afectado,
        id_hosting,
        detalleJson,
        ip_origen ? String(ip_origen).slice(0, 64) : null,
        user_agent,
    ];

    const qBase = { type: QueryTypes.INSERT };
    if (transaction) qBase.transaction = transaction;

    if (await cmsBitacoraTieneColumnaAccion(sequelize)) {
        await sequelize.query(
            `INSERT INTO cms_bitacora (
                fk_id_user_actor, fk_id_cat_bitacora_cms, fk_id_sysapp, id_wb_pagina, fk_id_cat_type_pagina,
                fk_id_user_afectado, id_hosting, detalle, ip_origen, user_agent, accion
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
            )`,
            { ...qBase, bind: [...bindBase, accionLegacy] }
        );
    } else {
        await sequelize.query(
            `INSERT INTO cms_bitacora (
                fk_id_user_actor, fk_id_cat_bitacora_cms, fk_id_sysapp, id_wb_pagina, fk_id_cat_type_pagina,
                fk_id_user_afectado, id_hosting, detalle, ip_origen, user_agent
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10
            )`,
            { ...qBase, bind: bindBase }
        );
    }
}

/**
 * Best-effort (no lanza).
 * @param {object} opts
 */
async function registraBitacora(opts) {
    try {
        await registraBitacoraInsert(dbCatalogDefault, opts, {});
    } catch (e) {
        console.error('[cms_bitacora]', e && e.message ? e.message : e);
    }
}

module.exports = { registraBitacora, registraBitacoraInsert, ACCION };
