const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes } = require('sequelize');

const sysapp_user_permModel = dbConection.define('sysapp_user_perm',
    {
        id_sysapp_user_perm: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_sysapp: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        fk_id_user: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        activo: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
        },
        fecha_asignacion: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        fecha_revocacion: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        fk_id_user_asignador: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
    },
    {
        tableName: 'sysapp_user_perm',
        createdAt: false,
        updatedAt: false,
    }
);

module.exports = sysapp_user_permModel;
