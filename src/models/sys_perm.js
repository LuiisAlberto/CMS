const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes } = require('sequelize');

const sys_permModel = dbConection.define('sys_perm',
    {
        id_sys_perm: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_user: {
            type: DataTypes.STRING,
        },
        fk_id_syssubmod: {
            type: DataTypes.STRING,
        },
        vigente: {
            type: DataTypes.INTEGER,
            defaultValue: true,
        },
        f_activo: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        f_vigencia: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
        },
        f_revoca: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
       fk_id_sysapp: {
            type: DataTypes.INTEGER,
        },
    },
    {
        tableName: 'sys_perm',
        createdAt: false,
        updatedAt: false
    }
);

module.exports = sys_permModel;