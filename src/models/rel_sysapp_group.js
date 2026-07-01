const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes } = require('sequelize');

const rel_sysapp_groupModel = dbConection.define('rel_sysapp_group',
    {
        id_rel_sysapp_group: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_sysapp: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        fk_id_sysapp_group: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        vigente: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
    },
    {
        tableName: 'rel_sysapp_group',
        createdAt: false,
        updatedAt: false
    }
);

module.exports = rel_sysapp_groupModel;