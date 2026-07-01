const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const modulosModel = dbConection.define('sysmod',
    {
        id_sysmod: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_sysapp_group: {
            type: DataTypes.INTEGER,
        },
        modulo: {
            type: DataTypes.STRING,
        },
        modulo_legend: {
            type: DataTypes.STRING,
        },
        vigente: {
            type: DataTypes.BOOLEAN,
        },
        order_mod: {
            type: DataTypes.INTEGER,
        },
        fk_id_sysapp_type: {
            type: DataTypes.INTEGER,
        },
        micon: {
            type: DataTypes.STRING,
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
    },
    {
        createdAt: false,
        updatedAt: false
    }
);
// modulosModel.sync()
// modulosModel.sync({ force: true })
module.exports = modulosModel;