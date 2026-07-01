const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes } = require('sequelize');

/** id 8 en cat_type_files = "Logo app" */
const idCatTypeLogo = 8;

const rel_sysapp_filesModel = dbConection.define('rel_sysapp_files',
    {
        id_rel_sysapp_file: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_file: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        fk_id_sysapp: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        fk_id_cat_type_files: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        vigente: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: true,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        f_no_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: true,
        },
    },
    {
        tableName: 'rel_sysapp_files',
        createdAt: false,
        updatedAt: false,
    }
);

rel_sysapp_filesModel.idCatTypeLogo = idCatTypeLogo;

module.exports = rel_sysapp_filesModel;
