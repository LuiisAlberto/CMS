const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const sub_moduloModel = dbConection.define('syssubmod',
    {
        id_syssubmod: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        submodulo: {
            type: DataTypes.STRING,
        },
        submodulo_legend: {
            type: DataTypes.STRING,
        },
        fk_id_sysmod: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'sysmod',
                key: 'id_sysmod',
            },
            onDelete: 'RESTRICT',
        },
        smicon: {
            type: DataTypes.STRING,
        },
        fk_id_ruta: {
            type: DataTypes.INTEGER,
            //allowNull: false,
            references: {
                model: 'rutas',
                key: 'id_ruta',
            },
            onDelete: 'RESTRICT',
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        order_submod: {
            type: DataTypes.INTEGER,
        },
        vigente: {
            type: DataTypes.BOOLEAN,
        },
    },
    {
        tableName: 'syssubmod',
        createdAt: false,
        updatedAt: false
    }
);
// sub_moduloModel.sync()
// sub_moduloModel.sync({ force: true })
module.exports = sub_moduloModel;