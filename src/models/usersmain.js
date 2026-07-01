const dbConection = require('../config/postgresMain');
/** BD del sitio (PGDB_NAME, ej. group_website_mrn): tablas wb_* locales; no sys_morena. */
const dbWebsite = require('../config/postgressdb');
const { Sequelize, DataTypes, QueryTypes, Op } = require('sequelize');

const usersModelMain = dbConection.define('users',
    {
        id_user: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        uname: {
            type: DataTypes.STRING,
        },
        upass: {
            type: DataTypes.STRING,
        },
        fk_id_cat_type_users: {
            type: DataTypes.INTEGER,
            //allowNull: false,
            references: {
                model: 'cat_type_users',
                key: 'id_cat_type_users',
            },
            onDelete: 'RESTRICT',
        },
        nombre: {
            type: DataTypes.STRING,
        },
        primer_apellido: {
            type: DataTypes.STRING,
        },
        segundo_apellido: {
            type: DataTypes.STRING,
        },
        email: {
            type: DataTypes.STRING,
        },
        telefono_fijo: {
            type: DataTypes.STRING,
        },
        telefono_celular: {
            type: DataTypes.STRING,
        },
        curp: {
            type: DataTypes.STRING,
        },
        rfc: {
            type: DataTypes.STRING,
        },
        fk_id_estado: {
            type: DataTypes.INTEGER,
        },
        fk_id_municipio: {
            type: DataTypes.INTEGER,
        },
        campass: {
            type: DataTypes.BOOLEAN,
        },
        activo: {
            type: DataTypes.BOOLEAN,
        },
        f_activo: {
            type: 'TIMESTAMP',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        vigente:{
            type: DataTypes.BOOLEAN,
        },
    },
    {
        createdAt: false,
        updatedAt: false,
    }
);

function isPgMissingRelationError(err) {
    const code = err && (err.parent && err.parent.code) || (err.original && err.original.code);
    return code === '42P01';
}

/**
 * Evita duplicate key en users.id_user cuando la secuencia quedó detrás del MAX(id_user).
 * Se ejecuta dentro de la misma transacción del alta.
 */
async function ensureUsersPkSequenceInTx() {
    await dbConection.query(
        `DO $$
         DECLARE
           mx bigint;
           seq text;
         BEGIN
           SELECT COALESCE(MAX(id_user), 0) INTO mx FROM users;
           seq := pg_get_serial_sequence('users', 'id_user');
           IF seq IS NULL AND to_regclass('public.users_id_user_seq') IS NOT NULL THEN
             seq := 'public.users_id_user_seq';
           END IF;
           IF seq IS NOT NULL THEN
             PERFORM setval(seq, mx + 1, false);
           END IF;
         END $$;`,
        { type: QueryTypes.RAW }
    );
}

/**
 * Lista usuarios con acceso a este CMS: sys_perm en el grupo y/o rol en rel_user_sysapp_roles (CMS_SYSAPP).
 * Así no se muestran todos los usuarios de sys_morena, solo quienes tienen acceso por cualquiera de esas vías.
 */
/**
 * Usuarios con acceso al CMS: sys_perm en el grupo, o rol en cat_roles_sysapp (CMS_SYSAPP) + rel_user_sysapp_roles.
 * $2 = id_sysapp del CMS (CMS_SYSAPP); si es NULL, solo aplica la rama sys_perm.
 */
const QUERY_USUARIOS_SYSAPP_GROUP = `
  SELECT DISTINCT ON (u.id_user)
    u.id_user,
    u.nombre, u.primer_apellido AS paterno, u.segundo_apellido AS materno, u.curp,
    ty.type_user, estado.estado, u.activo
  FROM users u
  LEFT JOIN cat_type_users AS ty ON u.fk_id_cat_type_users = ty.id_cat_type_users
  LEFT JOIN cat_estados AS estado ON u.fk_id_estado = estado.id_estado
  WHERE u.activo = true
    AND (
      EXISTS (
        SELECT 1 FROM sysapp_user_perm sup
        INNER JOIN rel_sysapp_group rg ON rg.fk_id_sysapp = sup.fk_id_sysapp
        WHERE sup.fk_id_user = u.id_user
          AND rg.fk_id_sysapp_group = $1::integer
          AND (sup.activo IS NOT FALSE)
      )
      OR
      EXISTS (
        SELECT 1 FROM sys_perm sp
        INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = sp.fk_id_sysapp
        WHERE sp.fk_id_user = u.id_user
          AND r.fk_id_sysapp_group = $1::integer
          AND (sp.vigente IS NOT FALSE)
      )
      OR (
        $2::integer IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM rel_user_sysapp_roles rur
          INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
            AND crs.fk_id_sysapp = $2::integer
            AND (crs.vigente IS NOT FALSE)
            AND (rur.vigente IS NOT FALSE)
          WHERE rur.fk_id_user = u.id_user
        )
      )
    )
  ORDER BY u.id_user
`;

/** Editor en listas de instancia = rol CMS (rel_user_sysapp_roles + cat_roles_sysapp), no users.fk_id_cat_type_users. */

const QUERY_USUARIOS_POR_INSTANCIAS = `
  SELECT DISTINCT ON (u.id_user)
    u.id_user,
    u.nombre, u.primer_apellido AS paterno, u.segundo_apellido AS materno, u.curp,
    ty.type_user, estado.estado, u.activo
  FROM users u
  LEFT JOIN cat_type_users AS ty ON u.fk_id_cat_type_users = ty.id_cat_type_users
  LEFT JOIN cat_estados AS estado ON u.fk_id_estado = estado.id_estado
  INNER JOIN sysapp_user_perm sup ON sup.fk_id_user = u.id_user
    AND sup.fk_id_sysapp = ANY($1::int[])
    AND (sup.activo IS NOT FALSE)
  WHERE u.activo = true
    AND EXISTS (
      SELECT 1
      FROM rel_user_sysapp_roles rur
      INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
      WHERE rur.fk_id_user = u.id_user
        AND crs.fk_id_sysapp = $2::integer
        AND (rur.vigente IS NOT FALSE)
        AND (crs.vigente IS NOT FALSE)
        AND lower(trim(coalesce(crs.rol, ''))) LIKE '%editor%'
    )
  ORDER BY u.id_user
`;

const QUERY_USUARIOS_POR_INSTANCIAS_LEGACY_EDITOR_ROL_NAME = `
  SELECT DISTINCT ON (u.id_user)
    u.id_user,
    u.nombre, u.primer_apellido AS paterno, u.segundo_apellido AS materno, u.curp,
    ty.type_user, estado.estado, u.activo
  FROM users u
  LEFT JOIN cat_type_users AS ty ON u.fk_id_cat_type_users = ty.id_cat_type_users
  LEFT JOIN cat_estados AS estado ON u.fk_id_estado = estado.id_estado
  INNER JOIN sysapp_user_perm sup ON sup.fk_id_user = u.id_user
    AND sup.fk_id_sysapp = ANY($1::int[])
    AND (sup.activo IS NOT FALSE)
  WHERE u.activo = true
    AND EXISTS (
      SELECT 1
      FROM rel_user_sysapp_roles rur
      INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
      WHERE rur.fk_id_user = u.id_user
        AND crs.fk_id_sysapp = $2::integer
        AND (rur.vigente IS NOT FALSE)
        AND (crs.vigente IS NOT FALSE)
        AND lower(trim(coalesce(crs.rol, ''))) LIKE '%editor%'
    )
  ORDER BY u.id_user
`;

/** Misma lista que QUERY_USUARIOS_POR_INSTANCIAS pero solo asignaciones dadas de alta por `fk_id_user_asignador`. Incluye nombres de instancia agregados. */
const QUERY_EDITORES_INSTANCIA_POR_ASIGNADOR = `
  SELECT
    u.id_user,
    u.nombre, u.primer_apellido AS paterno, u.segundo_apellido AS materno, u.curp,
    ty.type_user, estado.estado, u.activo,
    COALESCE(
      string_agg(
        COALESCE(sa.sysapp_name, sa.app_legend, 'Inst. ' || sup.fk_id_sysapp::text),
        ', '
        ORDER BY COALESCE(sa.sysapp_name, sa.app_legend, 'Inst. ' || sup.fk_id_sysapp::text)
      ),
      ''
    ) AS instancias_asignadas
  FROM users u
  LEFT JOIN cat_type_users AS ty ON u.fk_id_cat_type_users = ty.id_cat_type_users
  LEFT JOIN cat_estados AS estado ON u.fk_id_estado = estado.id_estado
  INNER JOIN sysapp_user_perm sup ON sup.fk_id_user = u.id_user
    AND sup.fk_id_sysapp = ANY($1::int[])
    AND (sup.activo IS NOT FALSE)
    AND sup.fk_id_user_asignador = $2::integer
  LEFT JOIN sysapp sa ON sa.id_sysapp = sup.fk_id_sysapp
  WHERE u.activo = true
    AND EXISTS (
      SELECT 1
      FROM rel_user_sysapp_roles rur
      INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
      WHERE rur.fk_id_user = u.id_user
        AND crs.fk_id_sysapp = $3::integer
        AND (rur.vigente IS NOT FALSE)
        AND (crs.vigente IS NOT FALSE)
        AND lower(trim(coalesce(crs.rol, ''))) LIKE '%editor%'
    )
  GROUP BY u.id_user, u.nombre, u.primer_apellido, u.segundo_apellido, u.curp,
    ty.type_user, estado.estado, u.activo
  ORDER BY u.id_user
`;

const QUERY_EDITORES_INSTANCIA_POR_ASIGNADOR_LEGACY_EDITOR_ROL_NAME = `
  SELECT
    u.id_user,
    u.nombre, u.primer_apellido AS paterno, u.segundo_apellido AS materno, u.curp,
    ty.type_user, estado.estado, u.activo,
    COALESCE(
      string_agg(
        COALESCE(sa.sysapp_name, sa.app_legend, 'Inst. ' || sup.fk_id_sysapp::text),
        ', '
        ORDER BY COALESCE(sa.sysapp_name, sa.app_legend, 'Inst. ' || sup.fk_id_sysapp::text)
      ),
      ''
    ) AS instancias_asignadas
  FROM users u
  LEFT JOIN cat_type_users AS ty ON u.fk_id_cat_type_users = ty.id_cat_type_users
  LEFT JOIN cat_estados AS estado ON u.fk_id_estado = estado.id_estado
  INNER JOIN sysapp_user_perm sup ON sup.fk_id_user = u.id_user
    AND sup.fk_id_sysapp = ANY($1::int[])
    AND (sup.activo IS NOT FALSE)
    AND sup.fk_id_user_asignador = $2::integer
  LEFT JOIN sysapp sa ON sa.id_sysapp = sup.fk_id_sysapp
  WHERE u.activo = true
    AND EXISTS (
      SELECT 1
      FROM rel_user_sysapp_roles rur
      INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
      WHERE rur.fk_id_user = u.id_user
        AND crs.fk_id_sysapp = $3::integer
        AND (rur.vigente IS NOT FALSE)
        AND (crs.vigente IS NOT FALSE)
        AND lower(trim(coalesce(crs.rol, ''))) LIKE '%editor%'
    )
  GROUP BY u.id_user, u.nombre, u.primer_apellido, u.segundo_apellido, u.curp,
    ty.type_user, estado.estado, u.activo
  ORDER BY u.id_user
`;

usersModelMain.findAllBySysappGroup = async function (fkIdSysappGroup) {
  const grupo = fkIdSysappGroup != null ? fkIdSysappGroup : process.env.GRUPO_APLICACIONES;
  const grupoNum = grupo != null ? parseInt(grupo, 10) : null;
  const bindVal = grupoNum != null && !isNaN(grupoNum) ? grupoNum : 1;
  const cmsRaw = process.env.CMS_SYSAPP;
  const cmsNum = cmsRaw != null && String(cmsRaw).trim() !== '' ? parseInt(cmsRaw, 10) : null;
  const cmsBind = cmsNum != null && !isNaN(cmsNum) ? cmsNum : null;

  try {
    const rows = await dbConection.query(QUERY_USUARIOS_SYSAPP_GROUP, {
      bind: [bindVal, cmsBind],
      type: QueryTypes.SELECT,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    const missing =
      e && ((e.parent && e.parent.code === '42P01') || (e.original && e.original.code === '42P01'));
    if (missing) {
      const rows = await dbConection.query(
        `
        SELECT DISTINCT ON (u.id_user)
          u.id_user,
          u.nombre, u.primer_apellido AS paterno, u.segundo_apellido AS materno, u.curp,
          ty.type_user, estado.estado, u.activo
        FROM users u
        LEFT JOIN cat_type_users AS ty ON u.fk_id_cat_type_users = ty.id_cat_type_users
        LEFT JOIN cat_estados AS estado ON u.fk_id_estado = estado.id_estado
        WHERE u.activo = true
          AND (
            EXISTS (
              SELECT 1 FROM sysapp_user_perm sup
              INNER JOIN rel_sysapp_group rg ON rg.fk_id_sysapp = sup.fk_id_sysapp
              WHERE sup.fk_id_user = u.id_user
                AND rg.fk_id_sysapp_group = $1::integer
                AND (sup.activo IS NOT FALSE)
            )
            OR EXISTS (
              SELECT 1 FROM sys_perm sp
              INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = sp.fk_id_sysapp
              WHERE sp.fk_id_user = u.id_user
                AND r.fk_id_sysapp_group = $1::integer
                AND (sp.vigente IS NOT FALSE)
            )
          )
        ORDER BY u.id_user
        `,
        { bind: [bindVal], type: QueryTypes.SELECT }
      );
      return Array.isArray(rows) ? rows : [];
    }
    throw e;
  }
};

usersModelMain.getAssignedInstanceIdsForUser = async function (idUser) {
    const uid = parseInt(idUser, 10);
    if (!Number.isFinite(uid)) return [];
    const rows = await dbConection.query(
        `SELECT DISTINCT fk_id_sysapp
         FROM sysapp_user_perm
         WHERE fk_id_user = $1::integer
           AND (activo IS NOT FALSE)`,
        {
            bind: [uid],
            type: QueryTypes.SELECT,
        }
    );
    return (rows || [])
        .map((r) => parseInt(r.fk_id_sysapp, 10))
        .filter((n) => Number.isFinite(n));
};

/**
 * Asegura filas en sysapp_user_perm para que el editor pueda operar en esas instancias
 * (alta por responsable). Reactiva si existía revocada.
 */
usersModelMain.ensureSysappUserPermForUser = async function (targetUserId, sysappIds, assignerUserId) {
    const uid = parseInt(targetUserId, 10);
    const asg = parseInt(assignerUserId, 10);
    const ids = [...new Set((sysappIds || []).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n)))];
    if (!Number.isFinite(uid) || !ids.length) return 0;
    let n = 0;
    for (const sid of ids) {
        const prev = await dbConection.query(
            `SELECT id_sysapp_user_perm, activo
             FROM sysapp_user_perm
             WHERE fk_id_user = $1::integer AND fk_id_sysapp = $2::integer
             LIMIT 1`,
            { bind: [uid, sid], type: QueryTypes.SELECT }
        );
        const row = prev && prev[0];
        if (!row) {
            await dbConection.query(
                `INSERT INTO sysapp_user_perm (fk_id_user, fk_id_sysapp, activo, fecha_asignacion, fk_id_user_asignador)
                 VALUES ($1::integer, $2::integer, true, CURRENT_TIMESTAMP, $3::integer)`,
                {
                    bind: [uid, sid, Number.isFinite(asg) ? asg : null],
                    type: QueryTypes.INSERT,
                }
            );
            n += 1;
        } else if (row.activo === false || row.activo === null) {
            await dbConection.query(
                `UPDATE sysapp_user_perm
                 SET activo = true,
                     fecha_asignacion = COALESCE(fecha_asignacion, CURRENT_TIMESTAMP),
                     fecha_revocacion = NULL,
                     fk_id_user_asignador = COALESCE($3::integer, fk_id_user_asignador)
                 WHERE fk_id_user = $1::integer AND fk_id_sysapp = $2::integer`,
                {
                    bind: [uid, sid, Number.isFinite(asg) ? asg : null],
                    type: QueryTypes.UPDATE,
                }
            );
            n += 1;
        }
    }
    return n;
};

/** Solo correo/tipo para editor cuando no hay cambios de permisos en el cuerpo. */
usersModelMain.updateUserInstanceEmailOnly = async function (data) {
    const id_user = parseInt(data.id_user, 10);
    const email = String(data.email || '').trim();
    const id_type = data.id_type != null ? String(data.id_type) : '13';
    if (!Number.isFinite(id_user) || !email) return false;
    try {
        await dbConection.query(
            `UPDATE users SET email = $2, uname = $2, fk_id_cat_type_users = $3::integer WHERE id_user = $1::integer`,
            {
                bind: [id_user, email, parseInt(id_type, 10)],
                type: QueryTypes.UPDATE,
            }
        );
        return true;
    } catch (e) {
        console.error('[updateUserInstanceEmailOnly]', e);
        return false;
    }
};

/** id_sysapp + app_legend para instancias recién creadas (no están en cat_apps_activas en memoria hasta reinicio). */
usersModelMain.getAppLegendsBySysappIds = async function (instanceIds) {
    const ids = Array.isArray(instanceIds)
        ? instanceIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
        : [];
    if (!ids.length) return [];
    const rows = await dbConection.query(
        `SELECT id_sysapp, app_legend
         FROM sysapp
         WHERE id_sysapp = ANY($1::int[])
           AND (vigente IS NOT FALSE)`,
        { bind: [ids], type: QueryTypes.SELECT }
    );
    return Array.isArray(rows) ? rows : [];
};

usersModelMain.findAllByInstanceIds = async function (instanceIds) {
    const ids = Array.isArray(instanceIds)
        ? instanceIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
        : [];
    if (!ids.length) return [];
    const cmsRaw = process.env.CMS_SYSAPP;
    const cmsNum = cmsRaw != null && String(cmsRaw).trim() !== '' ? parseInt(cmsRaw, 10) : NaN;
    if (!Number.isFinite(cmsNum)) return [];
    try {
        const rows = await dbConection.query(QUERY_USUARIOS_POR_INSTANCIAS, {
            bind: [ids, cmsNum],
            type: QueryTypes.SELECT,
        });
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        const msg = String(e?.message || '').toLowerCase();
        const missingEditorTypeColumn =
            e?.parent?.code === '42703' &&
            msg.includes('fk_id_cat_type_users');
        if (!missingEditorTypeColumn) throw e;
        const rowsLegacy = await dbConection.query(QUERY_USUARIOS_POR_INSTANCIAS_LEGACY_EDITOR_ROL_NAME, {
            bind: [ids, cmsNum],
            type: QueryTypes.SELECT,
        });
        return Array.isArray(rowsLegacy) ? rowsLegacy : [];
    }
};

/**
 * Usuarios instancia: editores cuyas filas en sysapp_user_perm fueron dadas de alta por `asignadorUserId`
 * (responsable) en las instancias indicadas.
 */
usersModelMain.findEditorsByInstanceIdsForRegistrant = async function (instanceIds, asignadorUserId) {
    const ids = Array.isArray(instanceIds)
        ? instanceIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
        : [];
    const aid = parseInt(asignadorUserId, 10);
    if (!ids.length || !Number.isFinite(aid)) return [];
    const cmsRaw = process.env.CMS_SYSAPP;
    const cmsNum = cmsRaw != null && String(cmsRaw).trim() !== '' ? parseInt(cmsRaw, 10) : NaN;
    if (!Number.isFinite(cmsNum)) return [];
    try {
        const rows = await dbConection.query(QUERY_EDITORES_INSTANCIA_POR_ASIGNADOR, {
            bind: [ids, aid, cmsNum],
            type: QueryTypes.SELECT,
        });
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        const msg = String(e?.message || '').toLowerCase();
        const missingEditorTypeColumn =
            e?.parent?.code === '42703' &&
            msg.includes('fk_id_cat_type_users');
        if (!missingEditorTypeColumn) throw e;
        const rowsLegacy = await dbConection.query(QUERY_EDITORES_INSTANCIA_POR_ASIGNADOR_LEGACY_EDITOR_ROL_NAME, {
            bind: [ids, aid, cmsNum],
            type: QueryTypes.SELECT,
        });
        return Array.isArray(rowsLegacy) ? rowsLegacy : [];
    }
};

/** Si el usuario no tiene tipo definido (NULL), asigna Editor (13) para altas por usuarios instancia. */
usersModelMain.ensureEditorTypeForUser = async function (idUser) {
    const uid = parseInt(idUser, 10);
    if (!Number.isFinite(uid)) return false;
    await dbConection.query(
        `UPDATE users SET fk_id_cat_type_users = 13 WHERE id_user = $1::integer AND fk_id_cat_type_users IS NULL`,
        { bind: [uid], type: QueryTypes.UPDATE }
    );
    return true;
};

usersModelMain.savePwd = async (uname,passtemp,nombre_completo,email) => {
    try {
        await dbConection.query(
            `INSERT INTO temporal.envio_psw (uname, psw,nombre_completo,email) VALUES ($1,$2,$3,$4)`,
            {
                bind: [uname, passtemp,nombre_completo,email],
                type: QueryTypes.INSERT,
            }
        );
        return true;
    } catch (error) {
        console.error(error);
        return false;
    }
};

/**
 * Resuelve id_cat_rol_sysapp para CMS_SYSAPP.
 * Prioridad:
 * 1) Mapeo explícito por cat_roles_sysapp.fk_id_cat_type_users (si existe en BD).
 * 2) Fallback por nombre de rol para tipos CMS conocidos (1=Administrador, 13=Editor).
 * Matriz legacy en addUser (si no hay rol aquí):
 * - tipo 1 Administrador: syssubmod bajo app tipo 1 «Administrador general» o usertype_perm×usertype_app.
 * - tipo 13 Editor: usertype_perm×usertype_app + fallback syssubmod 2 @ sysapp 1; con instancias, menú/pie por app tipo 2/3.
 * @param {object} [opts]
 * @param {boolean} [opts.inTransaction] Si es true, el caller ya ejecutó BEGIN en esta conexión; se usa SAVEPOINT
 *   para que un fallo del primer SELECT no aborte la transacción (25P02). Fuera de transacción SAVEPOINT falla (25P01).
 */
usersModelMain.resolveCmsRoleIdByCatTypeUsers = async function (catTypeUsersId, opts = {}) {
    const inTx = opts.inTransaction === true;
    const tid = parseInt(catTypeUsersId, 10);
    const cms = process.env.CMS_SYSAPP != null ? parseInt(process.env.CMS_SYSAPP, 10) : NaN;
    if (!Number.isFinite(tid) || !Number.isFinite(cms)) return null;

    const spMap = 'sp_res_cms_role_map';
    const sqlMapByFkType = `SELECT id_cat_rol_sysapp FROM cat_roles_sysapp
             WHERE fk_id_sysapp = $1::integer
               AND fk_id_cat_type_users = $2::integer
               AND (vigente IS NOT FALSE)
             ORDER BY id_cat_rol_sysapp ASC
             LIMIT 1`;

    const swallowFirstQueryError = (e) => {
        const missing =
            e && ((e.parent && e.parent.code === '42P01') || (e.original && e.original.code === '42P01'));
        const col = String(e.message || '').toLowerCase().includes('fk_id_cat_type_users');
        return missing || col;
    };

    if (inTx) {
        /**
         * Dentro de BEGIN: un fallo del primer SELECT aborta la transacción; SAVEPOINT permite seguir con el fallback.
         */
        await dbConection.query(`SAVEPOINT ${spMap}`);
        try {
            const rows = await dbConection.query(sqlMapByFkType, { bind: [cms, tid], type: QueryTypes.SELECT });
            const id = rows?.[0]?.id_cat_rol_sysapp;
            if (id != null) {
                await dbConection.query(`RELEASE SAVEPOINT ${spMap}`);
                return parseInt(id, 10);
            }
            await dbConection.query(`RELEASE SAVEPOINT ${spMap}`);
        } catch (e) {
            await dbConection.query(`ROLLBACK TO SAVEPOINT ${spMap}`);
            if (!swallowFirstQueryError(e)) throw e;
        }
    } else {
        try {
            const rows = await dbConection.query(sqlMapByFkType, { bind: [cms, tid], type: QueryTypes.SELECT });
            const id = rows?.[0]?.id_cat_rol_sysapp;
            if (id != null) return parseInt(id, 10);
        } catch (e) {
            if (!swallowFirstQueryError(e)) throw e;
        }
    }

    const roleAliases = {
        1: ['administrador'],
        13: ['editor'],
    };
    const aliases = roleAliases[tid] || [];
    if (!aliases.length) return null;

    try {
        const rowsByName = await dbConection.query(
            `SELECT id_cat_rol_sysapp
             FROM cat_roles_sysapp
             WHERE fk_id_sysapp = $1::integer
               AND (vigente IS NOT FALSE)
               AND lower(trim(rol)) = ANY($2::text[])
             ORDER BY id_cat_rol_sysapp ASC
             LIMIT 1`,
            { bind: [cms, aliases], type: QueryTypes.SELECT }
        );
        const idByName = rowsByName?.[0]?.id_cat_rol_sysapp;
        return idByName != null ? parseInt(idByName, 10) : null;
    } catch (e) {
        const missing =
            e && ((e.parent && e.parent.code === '42P01') || (e.original && e.original.code === '42P01'));
        if (missing) return null;
        throw e;
    }
};

/**
 * cat_roles_sysapp.default_sub_modules es INTEGER[]; según driver/consulta puede llegar como array,
 * string "{1,2,3}" u otro valor — si no es array, antes se dejaba vacío y no se copiaban syssubmod a sys_perm.
 */
function normalizeDefaultSubModuleIds(raw) {
    if (raw == null) return [];
    if (Array.isArray(raw)) {
        return raw.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
    }
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t || t === '{}') return [];
        const inner = t.replace(/^\{|\}$/g, '');
        if (!inner) return [];
        return inner
            .split(',')
            .map((x) => parseInt(x.trim(), 10))
            .filter((n) => Number.isFinite(n));
    }
    return [];
}

/**
 * Inserta/renueva rel_user_sysapp_roles y copia default_sub_modules → sys_perm (fk_id_sysapp = CMS_SYSAPP).
 * @param {Object} opts - inTransaction: true si ya hay BEGIN en dbConection
 */
usersModelMain.applyCmsRoleAccess = async function (userId, idCatRolSysapp, opts = {}) {
    const uid = parseInt(userId, 10);
    const rid = parseInt(idCatRolSysapp, 10);
    const cmsApp = process.env.CMS_SYSAPP != null ? parseInt(process.env.CMS_SYSAPP, 10) : NaN;
    const inTx = opts.inTransaction === true;
    if (!Number.isFinite(uid) || !Number.isFinite(rid) || !Number.isFinite(cmsApp)) {
        throw new Error('applyCmsRoleAccess: parámetros inválidos o falta CMS_SYSAPP');
    }

    const run = async () => {
        const rolRows = await dbConection.query(
            `SELECT id_cat_rol_sysapp, default_sub_modules, fk_id_sysapp
             FROM cat_roles_sysapp
             WHERE id_cat_rol_sysapp = $1::integer AND (vigente IS NOT FALSE)`,
            { bind: [rid], type: QueryTypes.SELECT }
        );
        const rol = rolRows && rolRows[0];
        if (!rol) throw new Error('Rol CMS no encontrado');
        const modIds = normalizeDefaultSubModuleIds(rol.default_sub_modules);
        if (!modIds.length) {
            console.warn(
                '[applyCmsRoleAccess] Rol id_cat_rol_sysapp=%s sin default_sub_modules aplicables (revisar cat_roles_sysapp).',
                rid
            );
        }

        await dbConection.query(
            `UPDATE rel_user_sysapp_roles rur
             SET vigente = false
             FROM cat_roles_sysapp crs
             WHERE rur.id_cat_rol_sysapp = crs.id_cat_rol_sysapp
               AND crs.fk_id_sysapp = $2::integer
               AND rur.fk_id_user = $1::integer
               AND rur.vigente IS NOT FALSE`,
            { bind: [uid, cmsApp], type: QueryTypes.UPDATE }
        );

        await dbConection.query(
            `INSERT INTO rel_user_sysapp_roles (id_cat_rol_sysapp, fk_id_user, vigente)
             VALUES ($1::integer, $2::integer, true)`,
            { bind: [rid, uid], type: QueryTypes.INSERT }
        );

        if (modIds.length > 0) {
            await dbConection.query(
                `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
                 SELECT $1::integer, u.sid, $3::integer
                 FROM unnest($2::integer[]) AS u(sid)
                 WHERE NOT EXISTS (
                   SELECT 1 FROM sys_perm sp
                   WHERE sp.fk_id_user = $1::integer
                     AND sp.fk_id_syssubmod = u.sid
                     AND sp.fk_id_sysapp = $3::integer
                     AND (sp.vigente IS NOT FALSE)
                 )`,
                { bind: [uid, modIds, cmsApp], type: QueryTypes.INSERT }
            );
        }
    };

    if (inTx) {
        await run();
    } else {
        await dbConection.query('BEGIN;');
        try {
            await run();
            await dbConection.query('COMMIT;');
        } catch (e) {
            await dbConection.query('ROLLBACK;');
            throw e;
        }
    }
};

/** Devuelve un rol CMS vigente del usuario para evitar re-registro duplicado. */
usersModelMain.getActiveCmsRoleAssignment = async function (userId) {
    const uid = parseInt(userId, 10);
    const cmsApp = process.env.CMS_SYSAPP != null ? parseInt(process.env.CMS_SYSAPP, 10) : NaN;
    if (!Number.isFinite(uid) || !Number.isFinite(cmsApp)) return null;
    try {
        const rows = await dbConection.query(
            `SELECT rur.id_rel_user_sysapp_rol, rur.id_cat_rol_sysapp, crs.rol
             FROM rel_user_sysapp_roles rur
             INNER JOIN cat_roles_sysapp crs ON crs.id_cat_rol_sysapp = rur.id_cat_rol_sysapp
             WHERE rur.fk_id_user = $1::integer
               AND crs.fk_id_sysapp = $2::integer
               AND (rur.id_rel_user_sysapp_rol IS NOT NULL)
               AND (rur.vigente IS NOT FALSE)
             ORDER BY rur.id_rel_user_sysapp_rol DESC
             LIMIT 1`,
            { bind: [uid, cmsApp], type: QueryTypes.SELECT }
        );
        return rows && rows[0] ? rows[0] : null;
    } catch (e) {
        const missing =
            e && ((e.parent && e.parent.code === '42P01') || (e.original && e.original.code === '42P01'));
        if (missing) return null;
        throw e;
    }
};

usersModelMain.addUser = async (data) => {
    console.log('[addUser] Inicio, email:', data.email);
    let uname = data.uname;
    let upass = data.hashedPass;
    let fk_id_cat_type_users = data.tipo;
    let nombre = data.nombre;
    let primer_apellido = data.primer_apellido;
    let segundo_apellido = data.segundo_apellido;
    let email = data.email;
    let telefono_fijo = data.telefono_fijo;
    let telefono_celular = data.telefono_celular;
    let curp = data.curp;
    let rfc = '';
    let fk_id_estado = data.fk_id_estado;
    uname = String(uname || '').trim().toLowerCase();
    email = String(email || '').trim().toLowerCase();
    /** null = sin filtro por instancia (p. ej. Administrador desde /users sin lista). [] = ninguna instancia explícita (Editor sin asignación automática). */
    let instanceIdsList;
    if (data.instanceIds === null || data.instanceIds === undefined) {
        instanceIdsList = null;
    } else if (Array.isArray(data.instanceIds)) {
        instanceIdsList = data.instanceIds
            .map((n) => parseInt(n, 10))
            .filter((n) => Number.isFinite(n));
    } else {
        instanceIdsList = [];
    }
    /** Alta admin vía matriz tipo 1: solo enlazar sysapp tipo 1 en sysapp_user_perm hasta que se asignen instancias. */
    let restrictSysappUserPermToTipo1Only = false;
    const skipInitialSysPerm = data.skipInitialSysPerm === true;
    const asignadorUserId =
        data.asignadorUserId != null ? parseInt(data.asignadorUserId, 10) : null;
    let cmsRoleIdResolved = null;
    try {
        cmsRoleIdResolved = await usersModelMain.resolveCmsRoleIdByCatTypeUsers(fk_id_cat_type_users);
    } catch (e) {
        console.warn('[addUser] resolveCmsRoleIdByCatTypeUsers', e && e.message);
    }
    if (skipInitialSysPerm && cmsRoleIdResolved == null) {
        console.warn(
            '[addUser] Alta con skipInitialSysPerm: no se resolvió rol CMS (tipo %s). Sin cat_roles_sysapp válido no habrá default_sub_modules vía applyCmsRoleAccess.',
            fk_id_cat_type_users
        );
    }
    /**
     * Mantener matriz base legacy para poblar sys_perm de menú al alta.
     * El rol CMS (cat_roles_sysapp) se sigue aplicando además como complemento.
     */
    const skipLegacyUsertypeMatrix = false;
    await dbConection.query('BEGIN;');
    try {
        await ensureUsersPkSequenceInTx();
        const rowsInsert = await dbConection.query(
            `INSERT INTO users(id_user,uname,upass,fk_id_cat_type_users,nombre,primer_apellido,segundo_apellido,email,telefono_fijo,telefono_celular,curp,rfc,fk_id_estado,campass,activo)
             VALUES(DEFAULT,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,true)
             RETURNING id_user`,
            {
                bind: [
                    uname,
                    upass,
                    fk_id_cat_type_users,
                    nombre,
                    primer_apellido,
                    segundo_apellido,
                    email,
                    telefono_fijo,
                    telefono_celular,
                    curp,
                    rfc,
                    fk_id_estado,
                ],
                type: QueryTypes.SELECT,
            }
        );
        const idUser = rowsInsert?.[0]?.id_user;
        if (idUser == null) throw new Error('No se obtuvo id_user al insertar');
        console.log('[addUser] Usuario insertado id_user:', idUser);

        /**
         * sys_perm inicial:
         * - Editor y otros: usertype_perm × usertype_app (cada fila en usertype_app × cada syssubmod en usertype_perm).
         *   Para Administrador eso generaba filas repetidas para el mismo submódulo (producto cartesiano) y
         *   duplicaba «Contenido» / «Documentos» en el menú.
         * - Administrador (desde /users, sin lista de instancias): solo sysmod de catálogo tipo 1 bajo la app
         *   «Administrador general». Los módulos de instancia (tipos 2/3) se otorgan al asignar instancia
         *   (grantBulkSysPermForInstanceApp), no en el alta.
         * sysapp_user_perm: si restrictSysappUserPermToTipo1Only, solo app(s) tipo 1 del grupo hasta asignar instancias.
         */
        let sysappFilterForPerm = instanceIdsList;
        const grupoEnv = process.env.GRUPO_APLICACIONES != null ? parseInt(process.env.GRUPO_APLICACIONES, 10) : null;
        const useAdminMatrizCatalogo =
            !skipInitialSysPerm &&
            Number(fk_id_cat_type_users) === 1 &&
            (instanceIdsList === null || instanceIdsList === undefined);

        /**
         * Excluir solo rutas que duplicaban menú en la matriz legacy (hosting, árbol categorías).
         * No excluir `users-instancia`: vive en Config. global junto a categorías/instancias y un
         * Administrador tipo 1 debe recibir su sys_perm al alta; si se omite, el modal muestra «X No»
         * en «Administrador de usuarios» / usuarios instancia.
         */
        const sqlArchivoNormR = `translate(trim(both '/' from lower(replace(coalesce(r.archivo, ''), '_', '-'))), 'áéíóúüñ', 'aeiouun')`;

        if (!skipInitialSysPerm && !skipLegacyUsertypeMatrix && useAdminMatrizCatalogo && grupoEnv != null && !isNaN(grupoEnv)) {
            const idAdmRows = await dbConection.query(
                `SELECT app.id_sysapp::integer AS id_sysapp
                 FROM sysapp app
                 INNER JOIN rel_sysapp_group rel ON rel.fk_id_sysapp = app.id_sysapp
                 WHERE rel.fk_id_sysapp_group = $1::integer
                   AND app.fk_id_sysapp_type = 1
                   AND (app.vigente IS NOT FALSE)
                 ORDER BY app.id_sysapp ASC
                 LIMIT 1`,
                { bind: [grupoEnv], type: QueryTypes.SELECT }
            );
            const idAdminGral =
                idAdmRows && idAdmRows[0] && idAdmRows[0].id_sysapp != null
                    ? parseInt(idAdmRows[0].id_sysapp, 10)
                    : null;

            if (Number.isFinite(idAdminGral)) {
                await dbConection.query(
                    `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
                     SELECT DISTINCT ON (s.id_syssubmod)
                         $1::integer,
                         s.id_syssubmod,
                         $2::integer
                     FROM syssubmod s
                     INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                     LEFT JOIN rutas r ON r.id_ruta = s.fk_id_ruta
                     WHERE m.fk_id_sysapp_group = $3::integer
                       AND m.fk_id_sysapp_type = 1
                       AND (m.vigente IS NOT FALSE)
                       AND (s.vigente IS NOT FALSE)
                       AND (r.id_ruta IS NULL OR r.vigente IS TRUE)
                       AND (
                           COALESCE(${sqlArchivoNormR}, '') = ''
                           OR (
                               ${sqlArchivoNormR} NOT IN ('hosting')
                               AND ${sqlArchivoNormR} NOT LIKE 'categorias%'
                           )
                       )
                     ORDER BY s.id_syssubmod`,
                    {
                        bind: [idUser, idAdminGral, grupoEnv],
                        type: QueryTypes.INSERT,
                    }
                );
                sysappFilterForPerm = null;
                restrictSysappUserPermToTipo1Only = true;
                console.log(
                    '[addUser] Administrador: sys_perm solo catálogo tipo 1 → fk_id_sysapp',
                    idAdminGral,
                    '; instancia(s) tipo 2/3 al asignar. sysapp_user_perm solo tipo 1 hasta entonces.'
                );
            } else {
                console.warn(
                    '[addUser] Administrador: no hay sysapp tipo 1 en el grupo; se usa INSERT usertype_perm (puede duplicar menú).'
                );
                await dbConection.query(
                    `INSERT INTO sys_perm(fk_id_user,fk_id_syssubmod,fk_id_sysapp)
                     SELECT $1,fk_id_syssubmod,fk_id_sysapp
                     FROM cat_type_users CTU
                              left join usertype_perm  up on CTU.id_cat_type_users = up.fk_id_type_usrsys
                              left join usertype_app  ut on CTU.id_cat_type_users = ut.fk_id_cat_type_users
                     WHERE CTU.vigente is true and fk_id_type_usrsys=$2
                       AND ($3::int[] IS NULL OR ut.fk_id_sysapp = ANY($3::int[]))
                     ORDER BY  fk_id_syssubmod`,
                    {
                        bind: [idUser, fk_id_cat_type_users, null],
                        type: QueryTypes.INSERT,
                    }
                );
            }
        } else if (!skipInitialSysPerm && !skipLegacyUsertypeMatrix) {
            await dbConection.query(
                `INSERT INTO sys_perm(fk_id_user,fk_id_syssubmod,fk_id_sysapp)
                 SELECT $1,fk_id_syssubmod,fk_id_sysapp
                 FROM cat_type_users CTU
                          left join usertype_perm  up on CTU.id_cat_type_users = up.fk_id_type_usrsys
                          left join usertype_app  ut on CTU.id_cat_type_users = ut.fk_id_cat_type_users
                 WHERE CTU.vigente is true and fk_id_type_usrsys=$2
                   AND ($3::int[] IS NULL OR ut.fk_id_sysapp = ANY($3::int[]))
                 ORDER BY  fk_id_syssubmod`,
                {
                    bind: [idUser, fk_id_cat_type_users, sysappFilterForPerm],
                    type: QueryTypes.INSERT,
                }
            );
        } else if (skipInitialSysPerm) {
            console.log('[addUser] skipInitialSysPerm: sin sys_perm iniciales (usuarios de instancia).');
            if (instanceIdsList != null && instanceIdsList.length > 0 && grupoEnv != null && !isNaN(grupoEnv)) {
                for (const aid of instanceIdsList) {
                    const appRows = await dbConection.query(
                        `SELECT fk_id_sysapp_type::integer AS t
                         FROM sysapp
                         WHERE id_sysapp = $1::integer
                           AND (vigente IS NOT FALSE)
                         LIMIT 1`,
                        { bind: [aid], type: QueryTypes.SELECT }
                    );
                    const fkType = appRows?.[0]?.t != null ? parseInt(appRows[0].t, 10) : NaN;
                    if (fkType !== 2 && fkType !== 3) continue;
                    await dbConection.query(
                        `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
                         SELECT $1::integer, s.id_syssubmod, $2::integer
                         FROM syssubmod s
                         INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
                         LEFT JOIN rutas r ON r.id_ruta = s.fk_id_ruta
                         WHERE m.fk_id_sysapp_group = $3::integer
                           AND m.fk_id_sysapp_type = $4::integer
                           AND (m.vigente IS NOT FALSE)
                           AND (s.vigente IS NOT FALSE)
                           AND (r.id_ruta IS NULL OR r.vigente IS TRUE)
                           ${sqlSysmodNotConfiguracionGlobalGrant('m')}
                           ${sqlRutaExcludedFromBulkInstancePermGrant('r')}
                           AND NOT EXISTS (
                             SELECT 1 FROM sys_perm ep
                             WHERE ep.fk_id_user = $1::integer
                               AND ep.fk_id_syssubmod = s.id_syssubmod
                               AND ep.fk_id_sysapp = $2::integer
                           )`,
                        {
                            bind: [idUser, aid, grupoEnv, fkType],
                            type: QueryTypes.INSERT,
                        }
                    );
                }
                console.log('[addUser] sys_perm base de instancia asignado en alta (skipInitialSysPerm=true).');
            }
        } else if (skipLegacyUsertypeMatrix) {
            console.log('[addUser] Permisos iniciales vía cat_roles_sysapp (sin usertype_perm legacy).');
        }

        if (cmsRoleIdResolved != null && Number.isFinite(cmsRoleIdResolved)) {
            await usersModelMain.applyCmsRoleAccess(idUser, cmsRoleIdResolved, { inTransaction: true });
        }

        // Fallback EDITOR (13): permiso mínimo sysapp 1 / submódulo 2 (categorías/tags).
        if (!skipInitialSysPerm && !skipLegacyUsertypeMatrix && Number(fk_id_cat_type_users) === 13) {
            await dbConection.query(
                `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp) VALUES ($1::integer, 2, 1)`,
                { bind: [idUser], type: QueryTypes.INSERT }
            );
            console.log('[addUser] Fallback sys_perm editor insertado (fk_id_sysapp=1, fk_id_syssubmod=2).');
        }

        // Menú/pie por instancia solo si hay instancias explícitas (evita contenido/documentos sin asignación).
        if (!skipInitialSysPerm && Number(fk_id_cat_type_users) === 13
            && instanceIdsList != null && instanceIdsList.length > 0) {
            const grupoInstRaw = process.env.GRUPO_APLICACIONES;
            const grupoInst = grupoInstRaw != null ? parseInt(grupoInstRaw, 10) : null;
            if (grupoInst != null && !isNaN(grupoInst)) {
                // Instancia nacional (tipo 2): menú (14) y pie (54)
                await dbConection.query(
                    `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
                     SELECT $1::integer, 14, app.id_sysapp
                     FROM sysapp app
                     INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = app.id_sysapp
                     WHERE r.fk_id_sysapp_group = $2::integer
                       AND app.fk_id_sysapp_type = 2
                       AND (app.vigente IS NOT FALSE)`,
                    { bind: [idUser, grupoInst], type: QueryTypes.INSERT }
                );
                await dbConection.query(
                    `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
                     SELECT $1::integer, 54, app.id_sysapp
                     FROM sysapp app
                     INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = app.id_sysapp
                     WHERE r.fk_id_sysapp_group = $2::integer
                       AND app.fk_id_sysapp_type = 2
                       AND (app.vigente IS NOT FALSE)`,
                    { bind: [idUser, grupoInst], type: QueryTypes.INSERT }
                );

                // Instancia secundaria (tipo 3): menú (55) y pie (202)
                await dbConection.query(
                    `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
                     SELECT $1::integer, 55, app.id_sysapp
                     FROM sysapp app
                     INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = app.id_sysapp
                     WHERE r.fk_id_sysapp_group = $2::integer
                       AND app.fk_id_sysapp_type = 3
                       AND (app.vigente IS NOT FALSE)`,
                    { bind: [idUser, grupoInst], type: QueryTypes.INSERT }
                );
                await dbConection.query(
                    `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
                     SELECT $1::integer, 202, app.id_sysapp
                     FROM sysapp app
                     INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = app.id_sysapp
                     WHERE r.fk_id_sysapp_group = $2::integer
                       AND app.fk_id_sysapp_type = 3
                       AND (app.vigente IS NOT FALSE)`,
                    { bind: [idUser, grupoInst], type: QueryTypes.INSERT }
                );
                console.log('[addUser] Fallback sys_perm editor: instancias nacional (14,54) y secundaria (55,202) asignadas.');
            } else {
                console.log('[addUser] No se pudieron asignar permisos de menú/pie a instancias: GRUPO_APLICACIONES inválido.');
            }
        }

        const grupoRaw = process.env.GRUPO_APLICACIONES;
        const grupo = grupoRaw != null ? parseInt(grupoRaw, 10) : null;
        console.log('[addUser] GRUPO_APLICACIONES env:', grupoRaw, '-> grupo (número):', grupo);

        if (grupo == null || isNaN(grupo)) {
            console.log('[addUser] No se inserta en sysapp_user_perm: grupo inválido. El usuario no aparecerá en la lista.');
        } else {
            const countRows = await dbConection.query(
                `SELECT COUNT(*) AS n FROM sysapp app
                 INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = app.id_sysapp
                 WHERE r.fk_id_sysapp_group = $1::integer AND app.fk_id_sysapp_type IN (1, 2, 3) AND (app.vigente IS NOT FALSE)`,
                { type: QueryTypes.SELECT, bind: [grupo] }
            );
            const n = countRows?.[0]?.n != null ? Number(countRows[0].n) : 0;
            console.log('[addUser] Apps en grupo', grupo, '(tipo 1, 2 o 3, vigentes):', n, 'countRows:', countRows);

            if (n === 0) {
                console.log('[addUser] No hay apps en el grupo. No se inserta sysapp_user_perm. El usuario no aparecerá en la lista.');
            } else {
                const tipoAppSql = restrictSysappUserPermToTipo1Only
                    ? 'AND app.fk_id_sysapp_type = 1'
                    : 'AND app.fk_id_sysapp_type IN (1, 2, 3)';
                await dbConection.query(
                    `INSERT INTO sysapp_user_perm (fk_id_user, fk_id_sysapp, activo, fecha_asignacion, fk_id_user_asignador)
                     SELECT $1::integer, app.id_sysapp, true, CURRENT_TIMESTAMP, $4::integer
                     FROM sysapp app
                     INNER JOIN rel_sysapp_group r ON r.fk_id_sysapp = app.id_sysapp
                     WHERE r.fk_id_sysapp_group = $2::integer
                       ${tipoAppSql}
                       AND (app.vigente IS NOT FALSE)
                       AND ($3::int[] IS NULL OR (cardinality($3::int[]) > 0 AND app.id_sysapp = ANY($3::int[])))`,
                    {
                        bind: [idUser, grupo, sysappFilterForPerm, Number.isFinite(asignadorUserId) ? asignadorUserId : null],
                        type: QueryTypes.INSERT,
                    }
                );
                console.log(
                    '[addUser] sysapp_user_perm insertado para id_user',
                    idUser,
                    restrictSysappUserPermToTipo1Only ? '(solo tipo 1)' : '(tipos 1–3)'
                );
            }
        }
        await dbConection.query('COMMIT;');
        return true;
    } catch (error) {
        console.error('[addUser] Error:', error);
        await dbConection.query('ROLLBACK;');
        return false;
    }
};

/**
 * Guardado desde administrador de usuarios (/users): con `preserveUserType` no se altera
 * `fk_id_cat_type_users` (usuarios con catálogo ajeno al CMS); el `id_type` del body sigue
 * gobernando rol CMS + `rel_user_sysapp_roles` vía `resolveCmsRoleIdByCatTypeUsers`.
 */
usersModelMain.updateUser = async (data) => {

    let id_user = data.id_user;
    let email = data.email;
    let id_type = data.id_type;
    let permisos = data.permisos;
    const preserveUserType = data.preserveUserType === true;

    await dbConection.query('BEGIN;');
    try {
        if (preserveUserType) {
            await dbConection.query(
                `UPDATE users SET email=$2, uname=$2 WHERE id_user=$1`,
                {
                    bind: [id_user, email],
                    type: QueryTypes.UPDATE,
                }
            );
        } else {
            await dbConection.query(
                `UPDATE users SET email=$2, uname=$2, fk_id_cat_type_users=$3 WHERE id_user=$1`,
                {
                    bind: [id_user, email, id_type],
                    type: QueryTypes.UPDATE,
                }
            );
        }

        // Consulta para actualizar los módulos antiguos
        const actualizarModulosAntiguos = await dbConection.query(
            `UPDATE sys_perm SET vigente=false, f_revoca=NOW() 
                WHERE fk_id_user=$1 and fk_id_sysapp in (SELECT fk_id_sysapp FROM rel_sysapp_group where fk_id_sysapp_group=$2)`,
            {
                bind: [id_user,process.env.GRUPO_APLICACIONES ],
                type: QueryTypes.UPDATE,
            }
        );

        for (const permiso of permisos) {
            await dbConection.query(
                `INSERT INTO sys_perm(fk_id_user,fk_id_syssubmod,fk_id_sysapp)
                 VALUES( $1, $2, $3)`,
                {
                    bind: [id_user,permiso.id_syssubmod,permiso.id_app],
                    type: QueryTypes.INSERT,
                }
            );
        }
        const cmsRoleIdResolved = await usersModelMain.resolveCmsRoleIdByCatTypeUsers(id_type, {
            inTransaction: true,
        });
        if (cmsRoleIdResolved != null && Number.isFinite(cmsRoleIdResolved)) {
            await usersModelMain.applyCmsRoleAccess(id_user, cmsRoleIdResolved, { inTransaction: true });
        }

        console.log('Actualizacion guardada');
        await dbConection.query('COMMIT;');
        return true;
    } catch (error) {
        const code = error && error.parent && error.parent.code;
        const detail = error && error.parent && error.parent.detail;
        if (code === '23505' && detail && String(detail).includes('sys_perm_pkey')) {
            console.error(
                '[updateUser] PK duplicada en sys_perm: la secuencia de id_sys_perm está desfasada. ' +
                    'Ejecute: app/migrations/fix_sys_perm_pkey_sequence.sql en la BD del CMS.',
                detail
            );
        } else {
            console.error(error);
        }
        await dbConection.query('ROLLBACK;');
        return false;
    }
};

/**
 * Actualiza permisos solo para instancias indicadas (módulo usuarios de instancia).
 * `permisos`: [{ id_syssubmod, id_app }]
 * `revokePermSysappIds`: instancias donde se revoca sys_perm antes de reinsertar (debe incluir el alcance
 *   completo del otorgante; si solo es `allowedSysappIds`, al quitar una instancia del formulario no se borraban permisos).
 * `grantorSysappIds`: elimina filas en `sysapp_user_perm` del otorgante en instancias que ya no están en
 *   `allowedSysappIds` (baja de vínculo editor–instancia sin usar `activo = false`; la baja lógica por
 *   desactivación de usuario sigue en `revokeCmsAccessForUser`).
 * `preserveUserType`: si es true, solo actualiza email/uname; no modifica `fk_id_cat_type_users` (usuarios ya existentes
 *   con otro tipo conservan su catálogo; el acceso editor CMS sigue resolviéndose con `id_type` + `rel_user_sysapp_roles`).
 */
usersModelMain.updateUserInstance = async (data) => {
    const id_user = data.id_user;
    const email = data.email;
    const id_type = data.id_type;
    const permisos = Array.isArray(data.permisos) ? data.permisos : [];
    const preserveUserType = data.preserveUserType === true;
    const allowedSysappIds = Array.isArray(data.allowedSysappIds)
        ? data.allowedSysappIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
        : [];
    const revokePermSysappIds = Array.isArray(data.revokePermSysappIds) && data.revokePermSysappIds.length
        ? [...new Set(data.revokePermSysappIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n)))]
        : allowedSysappIds;
    const grantorSysappIds = Array.isArray(data.grantorSysappIds) && data.grantorSysappIds.length
        ? [...new Set(data.grantorSysappIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n)))]
        : [];

    if (!revokePermSysappIds.length) return false;

    await dbConection.query('BEGIN;');
    try {
        if (preserveUserType) {
            await dbConection.query(
                `UPDATE users SET email=$2, uname=$2 WHERE id_user=$1`,
                {
                    bind: [id_user, email],
                    type: QueryTypes.UPDATE,
                }
            );
        } else {
            await dbConection.query(
                `UPDATE users SET email=$2, uname=$2, fk_id_cat_type_users=$3 WHERE id_user=$1`,
                {
                    bind: [id_user, email, id_type],
                    type: QueryTypes.UPDATE,
                }
            );
        }

        if (grantorSysappIds.length) {
            await dbConection.query(
                `DELETE FROM sysapp_user_perm
                 WHERE fk_id_user = $1::integer
                   AND fk_id_sysapp = ANY($2::int[])
                   AND NOT (fk_id_sysapp = ANY($3::int[]))`,
                {
                    bind: [id_user, grantorSysappIds, allowedSysappIds],
                    type: QueryTypes.DELETE,
                }
            );
        }

        await dbConection.query(
            `UPDATE sys_perm SET vigente=false, f_revoca=NOW()
             WHERE fk_id_user=$1 AND fk_id_sysapp = ANY($2::int[])`,
            {
                bind: [id_user, revokePermSysappIds],
                type: QueryTypes.UPDATE,
            }
        );

        for (const permiso of permisos) {
            await dbConection.query(
                `INSERT INTO sys_perm(fk_id_user,fk_id_syssubmod,fk_id_sysapp)
                 VALUES( $1, $2, $3)`,
                {
                    bind: [id_user, permiso.id_syssubmod, permiso.id_app],
                    type: QueryTypes.INSERT,
                }
            );
        }
        const cmsRoleIdResolved = await usersModelMain.resolveCmsRoleIdByCatTypeUsers(id_type, {
            inTransaction: true,
        });
        if (cmsRoleIdResolved != null && Number.isFinite(cmsRoleIdResolved)) {
            await usersModelMain.applyCmsRoleAccess(id_user, cmsRoleIdResolved, { inTransaction: true });
        }

        await dbConection.query('COMMIT;');
        return true;
    } catch (error) {
        console.error('[updateUserInstance]', error);
        await dbConection.query('ROLLBACK;');
        return false;
    }
};

/**
 * ¿Tiene el usuario `sys_perm` vigente sobre alguna sysapp que no pertenezca al grupo de aplicaciones CMS?
 * Si no podemos resolver el grupo, se asume true (no desactivar la fila global en `users` sin certeza).
 */
usersModelMain.userHasActiveSysPermOutsideGrupo = async function (userId, grupoId) {
    const uid = parseInt(userId, 10);
    const gid = parseInt(grupoId, 10);
    if (!Number.isFinite(uid) || !Number.isFinite(gid)) return true;
    const rows = await dbConection.query(
        `SELECT EXISTS (
            SELECT 1
            FROM sys_perm sp
            INNER JOIN sysapp sa ON sa.id_sysapp = sp.fk_id_sysapp
            WHERE sp.fk_id_user = $1::integer
              AND (sp.vigente IS NOT FALSE)
              AND NOT EXISTS (
                SELECT 1
                FROM rel_sysapp_group rg
                WHERE rg.fk_id_sysapp = sa.id_sysapp
                  AND rg.fk_id_sysapp_group = $2::integer
              )
        ) AS x`,
        { bind: [uid, gid], type: QueryTypes.SELECT }
    );
    const v = rows && rows[0] && rows[0].x;
    return v === true || v === 't' || v === 'true' || v === 1;
};

/**
 * Baja de acceso al bloque CMS (grupo + app CMS): roles y permisos en CMS_SYSAPP, y `sysapp_user_perm`
 * en sysapps del grupo (tipos 1–3). Usar desde desactivación explícita de usuario, no desde edición de permisos.
 */
usersModelMain.revokeCmsAccessForUser = async function (userId) {
    const uid = parseInt(userId, 10);
    const cmsApp = process.env.CMS_SYSAPP != null ? parseInt(process.env.CMS_SYSAPP, 10) : NaN;
    const grupoRaw = process.env.GRUPO_APLICACIONES;
    const grupo = grupoRaw != null ? parseInt(grupoRaw, 10) : NaN;
    if (!Number.isFinite(uid)) return false;
    await dbConection.query('BEGIN;');
    try {
        if (Number.isFinite(cmsApp)) {
            await dbConection.query(
                `UPDATE rel_user_sysapp_roles rur
                 SET vigente = false
                 FROM cat_roles_sysapp crs
                 WHERE rur.id_cat_rol_sysapp = crs.id_cat_rol_sysapp
                   AND crs.fk_id_sysapp = $2::integer
                   AND rur.fk_id_user = $1::integer
                   AND (rur.vigente IS NOT FALSE)`,
                { bind: [uid, cmsApp], type: QueryTypes.UPDATE }
            );
            await dbConection.query(
                `UPDATE sys_perm
                 SET vigente = false, f_revoca = NOW()
                 WHERE fk_id_user = $1::integer
                   AND fk_id_sysapp = $2::integer
                   AND (vigente IS NOT FALSE)`,
                { bind: [uid, cmsApp], type: QueryTypes.UPDATE }
            );
        }
        if (Number.isFinite(grupo)) {
            await dbConection.query(
                `UPDATE sysapp_user_perm sup
                 SET activo = false, fecha_revocacion = NOW()
                 WHERE sup.fk_id_user = $1::integer
                   AND (sup.activo IS NOT FALSE)
                   AND EXISTS (
                     SELECT 1
                     FROM sysapp app
                     INNER JOIN rel_sysapp_group rg ON rg.fk_id_sysapp = app.id_sysapp
                     WHERE app.id_sysapp = sup.fk_id_sysapp
                       AND rg.fk_id_sysapp_group = $2::integer
                       AND app.fk_id_sysapp_type IN (1, 2, 3)
                       AND (app.vigente IS NOT FALSE)
                   )`,
                { bind: [uid, grupo], type: QueryTypes.UPDATE }
            );
        }
        await dbConection.query('COMMIT;');
        return true;
    } catch (e) {
        console.error('[revokeCmsAccessForUser]', e);
        await dbConection.query('ROLLBACK;');
        return false;
    }
};

/**
 * Contraparte de `revokeCmsAccessForUser` al reactivar desde administración global.
 */
usersModelMain.reactivateCmsAccessForUser = async function (userId) {
    const uid = parseInt(userId, 10);
    const cmsApp = process.env.CMS_SYSAPP != null ? parseInt(process.env.CMS_SYSAPP, 10) : NaN;
    const grupoRaw = process.env.GRUPO_APLICACIONES;
    const grupo = grupoRaw != null ? parseInt(grupoRaw, 10) : NaN;
    if (!Number.isFinite(uid)) return false;
    await dbConection.query('BEGIN;');
    try {
        if (Number.isFinite(grupo)) {
            await dbConection.query(
                `UPDATE sysapp_user_perm sup
                 SET activo = true,
                     fecha_revocacion = NULL,
                     fecha_asignacion = COALESCE(fecha_asignacion, CURRENT_TIMESTAMP)
                 WHERE sup.fk_id_user = $1::integer
                   AND (sup.activo IS NOT TRUE)
                   AND EXISTS (
                     SELECT 1
                     FROM sysapp app
                     INNER JOIN rel_sysapp_group rg ON rg.fk_id_sysapp = app.id_sysapp
                     WHERE app.id_sysapp = sup.fk_id_sysapp
                       AND rg.fk_id_sysapp_group = $2::integer
                       AND app.fk_id_sysapp_type IN (1, 2, 3)
                       AND (app.vigente IS NOT FALSE)
                   )`,
                { bind: [uid, grupo], type: QueryTypes.UPDATE }
            );
        }
        const typeRows = await dbConection.query(
            `SELECT fk_id_cat_type_users FROM users WHERE id_user = $1::integer LIMIT 1`,
            { bind: [uid], type: QueryTypes.SELECT }
        );
        const tidRaw = typeRows && typeRows[0] ? typeRows[0].fk_id_cat_type_users : null;
        const tid = tidRaw != null ? parseInt(tidRaw, 10) : NaN;
        if (Number.isFinite(tid)) {
            const cmsRoleIdResolved = await usersModelMain.resolveCmsRoleIdByCatTypeUsers(tid, {
                inTransaction: true,
            });
            if (cmsRoleIdResolved != null && Number.isFinite(cmsRoleIdResolved)) {
                await usersModelMain.applyCmsRoleAccess(uid, cmsRoleIdResolved, { inTransaction: true });
            }
        }
        await dbConection.query('COMMIT;');
        return true;
    } catch (e) {
        console.error('[reactivateCmsAccessForUser]', e);
        await dbConection.query('ROLLBACK;');
        return false;
    }
};

/**
 * Reemplaza alcances de página por instancia (wb_user_editor_pagina_scope en PGDB_NAME).
 * No usa DELETE: baja lógica con vigente = false y reactiva o inserta filas vigentes.
 * `scopes`: por app (string id sysapp):
 *   - { "94": { "1": { all: true }, "2": { all: false, pageIds: [3, 7] } } }
 *   - legado: { "94": [1, 2, 5] } (equivale a all: true por tipo)
 *   - legado: pageId único se acepta como una entrada en pageIds
 * fk_id_wb_pagina NULL = todas las páginas de ese tipo; varias filas con ids = solo esas páginas.
 */
usersModelMain.replacePaginaScopesForUser = async (idUser, scopesByApp, opts = {}) => {
    const uid = parseInt(idUser, 10);
    if (!Number.isFinite(uid)) return false;
    const allowed = Array.isArray(opts.allowedSysappIds)
        ? opts.allowedSysappIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
        : null;

    const upsertPaginaScopeRow = async (aid, tipo, pageIdNullable) => {
        const rows = await dbWebsite.query(
            `SELECT id_wb_user_editor_pagina_scope
             FROM wb_user_editor_pagina_scope
             WHERE fk_id_user = $1::integer AND fk_id_sysapp = $2::integer
               AND fk_id_cat_type_pagina = $3::integer
               AND (fk_id_wb_pagina IS NOT DISTINCT FROM $4::integer)
             LIMIT 1`,
            {
                bind: [uid, aid, tipo, pageIdNullable],
                type: QueryTypes.SELECT,
            }
        );
        const list = Array.isArray(rows) ? rows : [];
        if (list.length) {
            await dbWebsite.query(
                `UPDATE wb_user_editor_pagina_scope
                 SET vigente = true
                 WHERE id_wb_user_editor_pagina_scope = $1::integer`,
                {
                    bind: [list[0].id_wb_user_editor_pagina_scope],
                    type: QueryTypes.UPDATE,
                }
            );
            return;
        }
        await dbWebsite.query(
            `INSERT INTO wb_user_editor_pagina_scope (fk_id_user, fk_id_sysapp, fk_id_cat_type_pagina, fk_id_wb_pagina, vigente)
             VALUES ($1::integer, $2::integer, $3::integer, $4::integer, true)`,
            {
                bind: [uid, aid, tipo, pageIdNullable],
                type: QueryTypes.INSERT,
            }
        );
    };

    await dbWebsite.query('BEGIN;');
    try {
        let revokeScopeList = null;
        if (Array.isArray(opts.revokeScopeSysappIds) && opts.revokeScopeSysappIds.length) {
            revokeScopeList = [
                ...new Set(
                    opts.revokeScopeSysappIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
                ),
            ];
        } else if (allowed && allowed.length) {
            revokeScopeList = allowed;
        }
        if (revokeScopeList && revokeScopeList.length) {
            await dbWebsite.query(
                `UPDATE wb_user_editor_pagina_scope
                 SET vigente = false
                 WHERE fk_id_user = $1::integer AND fk_id_sysapp = ANY($2::int[])`,
                { bind: [uid, revokeScopeList], type: QueryTypes.UPDATE }
            );
        } else {
            await dbWebsite.query(
                `UPDATE wb_user_editor_pagina_scope SET vigente = false WHERE fk_id_user = $1::integer`,
                { bind: [uid], type: QueryTypes.UPDATE }
            );
        }

        const entries = Object.entries(scopesByApp || {});
        for (const [appKey, tiposVal] of entries) {
            const aid = parseInt(appKey, 10);
            if (!Number.isFinite(aid)) continue;

            if (Array.isArray(tiposVal)) {
                for (const t of tiposVal) {
                    const tipo = parseInt(t, 10);
                    if (!Number.isFinite(tipo)) continue;
                    await upsertPaginaScopeRow(aid, tipo, null);
                }
                continue;
            }

            if (tiposVal && typeof tiposVal === 'object') {
                for (const [tipoStr, spec] of Object.entries(tiposVal)) {
                    const tipo = parseInt(tipoStr, 10);
                    if (!Number.isFinite(tipo)) continue;
                    const s = spec && typeof spec === 'object' ? spec : {};
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
                        const uniq = [...new Set(ids)];
                        for (const pid of uniq) {
                            await upsertPaginaScopeRow(aid, tipo, pid);
                        }
                    } else {
                        await upsertPaginaScopeRow(aid, tipo, null);
                    }
                }
            }
        }

        await dbWebsite.query('COMMIT;');
        return true;
    } catch (error) {
        console.error('[replacePaginaScopesForUser]', error);
        try {
            await dbWebsite.query('ROLLBACK;');
        } catch (_) {
            /* ignore */
        }
        if (isPgMissingRelationError(error)) {
            console.warn(
                '[replacePaginaScopesForUser] Tabla wb_user_editor_pagina_scope no existe en PGDB_NAME; ejecuta app/src/scripts/sql/wb_user_editor_pagina_scope.sql (BD del proyecto, ej. group_website_mrn).'
            );
            return true;
        }
        return false;
    }
};

/**
 * Lee alcances por instancia para un usuario (tabla en PGDB_NAME, no sys_morena).
 * Si la tabla aún no existe en BD (migración pendiente), devuelve {} sin tumbar la petición.
 */
usersModelMain.getPaginaScopesForUser = async (idUser) => {
    const uid = parseInt(idUser, 10);
    if (!Number.isFinite(uid)) return {};
    try {
        const rows = await dbWebsite.query(
            `SELECT fk_id_sysapp, fk_id_cat_type_pagina, fk_id_wb_pagina
             FROM wb_user_editor_pagina_scope
             WHERE fk_id_user = $1::integer AND (vigente IS NOT FALSE)
             ORDER BY fk_id_sysapp, fk_id_cat_type_pagina`,
            { bind: [uid], type: QueryTypes.SELECT }
        );
        const groups = new Map();
        for (const r of rows || []) {
            const aid = String(r.fk_id_sysapp);
            const tipo = String(parseInt(r.fk_id_cat_type_pagina, 10));
            const k = `${aid}|${tipo}`;
            if (!groups.has(k)) groups.set(k, { hasNull: false, ids: new Set() });
            const g = groups.get(k);
            const pidRaw = r.fk_id_wb_pagina;
            if (pidRaw == null || pidRaw === '') {
                g.hasNull = true;
            } else {
                const pid = parseInt(pidRaw, 10);
                if (Number.isFinite(pid)) g.ids.add(pid);
            }
        }
        const out = {};
        for (const [k, g] of groups) {
            const [aid, tipo] = k.split('|');
            if (!out[aid]) out[aid] = {};
            if (g.hasNull) {
                out[aid][tipo] = { all: true };
            } else {
                const arr = [...g.ids].filter((n) => Number.isFinite(n));
                out[aid][tipo] = { all: false, pageIds: arr };
            }
        }
        return out;
    } catch (e) {
        if (isPgMissingRelationError(e)) {
            console.warn(
                '[getPaginaScopesForUser] Tabla wb_user_editor_pagina_scope no existe en PGDB_NAME. Ejecuta app/src/scripts/sql/wb_user_editor_pagina_scope.sql (BD del proyecto, ej. group_website_mrn).'
            );
            return {};
        }
        throw e;
    }
};

/** Igual criterio que adminController.insertSysPermResponsablePorTipoInstancia (menú por instancia). */
function sqlArchivoNormGrant(aliasTable = 'r') {
    return `translate(trim(both '/' from lower(replace(coalesce(${aliasTable}.archivo, ''), '_', '-'))), 'áéíóúüñ', 'aeiouun')`;
}
function sqlSysmodNotConfiguracionGlobalGrant(aliasTable = 'm') {
    const t = (col) =>
        `translate(lower(trim(coalesce(${aliasTable}.${col}, ''))), 'áéíóúüñ', 'aeiouun')`;
    return `AND ${t('modulo')} NOT LIKE '%configuracion global%'
          AND ${t('modulo_legend')} NOT LIKE '%configuracion global%'
          AND ${t('modulo')} NOT LIKE '%administrador general%'
          AND ${t('modulo_legend')} NOT LIKE '%administrador general%'`;
}
function sqlRutaExcludedFromBulkInstancePermGrant(aliasR = 'r') {
    const n = sqlArchivoNormGrant(aliasR);
    // Sin submódulo «categorías» (/categorias y APIs bajo esa ruta); se mantienen instancias y métricas.
    return `AND (${n} IS NULL OR ${n} = '' OR (${n} NOT IN ('users-instancia', 'instancias') AND ${n} NOT LIKE 'categorias%'))`;
}

/**
 * Inserta sys_perm de módulos de instancia (catálogo tipo 2 o 3) para fk_id_sysapp = instancia concreta.
 * Idempotente: no duplica si ya existe la terna usuario/submódulo/app.
 */
usersModelMain.grantBulkSysPermForInstanceApp = async function (userId, instanceSysappId) {
    const uid = parseInt(userId, 10);
    const aid = parseInt(instanceSysappId, 10);
    const gidRaw = process.env.GRUPO_APLICACIONES;
    const gid = gidRaw != null ? parseInt(gidRaw, 10) : NaN;
    if (!Number.isFinite(uid) || !Number.isFinite(aid) || !Number.isFinite(gid)) {
        return false;
    }
    const typeRows = await dbConection.query(
        `SELECT fk_id_sysapp_type::integer AS t
         FROM sysapp
         WHERE id_sysapp = $1::integer
           AND (vigente IS NOT FALSE)
         LIMIT 1`,
        { bind: [aid], type: QueryTypes.SELECT }
    );
    const fkType = typeRows?.[0]?.t != null ? parseInt(typeRows[0].t, 10) : NaN;
    if (fkType !== 2 && fkType !== 3) {
        return false;
    }
    try {
        await dbConection.query(
            `INSERT INTO sys_perm (fk_id_user, fk_id_syssubmod, fk_id_sysapp)
             SELECT $1::integer, s.id_syssubmod, $2::integer
             FROM syssubmod s
             INNER JOIN sysmod m ON m.id_sysmod = s.fk_id_sysmod
             LEFT JOIN rutas r ON r.id_ruta = s.fk_id_ruta
             WHERE m.fk_id_sysapp_group = $3::integer
               AND m.fk_id_sysapp_type = $4::integer
               AND (m.vigente IS NOT FALSE)
               AND (s.vigente IS NOT FALSE)
               AND (r.id_ruta IS NULL OR r.vigente IS TRUE)
               ${sqlSysmodNotConfiguracionGlobalGrant('m')}
               ${sqlRutaExcludedFromBulkInstancePermGrant('r')}
               AND NOT EXISTS (
                 SELECT 1 FROM sys_perm ep
                 WHERE ep.fk_id_user = $1::integer
                   AND ep.fk_id_syssubmod = s.id_syssubmod
                   AND ep.fk_id_sysapp = $2::integer
               )`,
            {
                bind: [uid, aid, gid, fkType],
                type: QueryTypes.INSERT,
            }
        );
        console.log('[grantBulkSysPermForInstanceApp] uid', uid, 'sysapp', aid, 'tipo', fkType);
        return true;
    } catch (e) {
        console.error('[grantBulkSysPermForInstanceApp]', e?.message || e);
        return false;
    }
};

module.exports =    usersModelMain;
