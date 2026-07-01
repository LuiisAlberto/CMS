const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes, Op } = require('sequelize');

/**
 * IDs de instancia con baja de dominio solicitada (4) o procesada (5). Esas filas pueden seguir con
 * sysapp.vigente = true hasta que Infra procesa la baja; no deben contar como «la nacional vigente»
 * que impide crear otra.
 */
async function fetchSysappIdsEnFlujoBajaDominio() {
    const HostingModel = require('./HostingModel');
    const rows = await HostingModel.findAll({
        where: { fk_id_estatus_hosting: { [Op.in]: [4, 5] } },
        attributes: ['fk_id_sysapp'],
        raw: true
    });
    return [...new Set(rows.map((r) => r.fk_id_sysapp).filter((id) => id != null))];
}

function whereOcupacionNacional({ idsExcluirBajaDominio, excludeIdSysapp }) {
    const and = [{ fk_id_sysapp_type: 2 }, { vigente: true }];
    if (idsExcluirBajaDominio?.length) {
        and.push({ id_sysapp: { [Op.notIn]: idsExcluirBajaDominio } });
    }
    if (excludeIdSysapp != null) {
        and.push({ id_sysapp: { [Op.ne]: excludeIdSysapp } });
    }
    return { [Op.and]: and };
}

const sysappModel = dbConection.define('sysapp',
    {
        id_sysapp: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        sysapp_name: {
            type: DataTypes.STRING,
        },
        fk_id_sysapp_type: {
            type: DataTypes.INTEGER,
        },

        app_legend: {
            type: DataTypes.STRING,
        },

        app_desc: {
            type: DataTypes.STRING,
        },
        app_favicon: {
            type: DataTypes.STRING,
        },
        key_sysapp: {
            type: DataTypes.STRING,
        },
        urluri: {
            type: DataTypes.STRING,
        },
        vigente:{
            type: DataTypes.BOOLEAN,
        },
        publicada:{
            type: DataTypes.BOOLEAN,
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        }

    },
    {
        createdAt: false,
        updatedAt: false,
        tableName: 'sysapp',
        hooks: {
            /**
             * No duplicar la regla «una nacional» en beforeCreate: CreateInst ya valida con la misma
             * función (countNacionalVigenteQueBloqueaNueva) dentro de la transacción. Un hook aquí sin
             * transaction alineada provocaba fallos opacos (p. ej. mensaje genérico «Validation error»).
             */
            async beforeUpdate(instance, options) {
                if (instance.changed('fk_id_sysapp_type') && parseInt(instance.fk_id_sysapp_type, 10) === 2) {
                    const n = await sysappModel.countNacionalVigenteQueBloqueaNueva(
                        instance.id_sysapp,
                        options.transaction
                    );
                    if (n > 0) {
                        throw new Error(
                            'Solo puede existir una instancia nacional (tipo 2). Elimine la existente si desea registrar otra.'
                        );
                    }
                }
            }
        }
    }
);

/** Para validación en CreateInst: misma regla que los hooks. `transaction` opcional (postgresMain). */
sysappModel.countNacionalVigenteQueBloqueaNueva = async function (excludeIdSysapp, transaction) {
    const idsBaja = await fetchSysappIdsEnFlujoBajaDominio();
    const excl = Number.isFinite(excludeIdSysapp) && excludeIdSysapp > 0 ? excludeIdSysapp : null;
    return sysappModel.count({
        where: whereOcupacionNacional({
            idsExcluirBajaDominio: idsBaja,
            excludeIdSysapp: excl
        }),
        transaction
    });
};

module.exports = sysappModel;