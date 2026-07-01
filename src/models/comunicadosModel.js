const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const comunicadosModel = dbConection.define('comunicados',
    {
        id_comunicado: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        titulo: {
            type: DataTypes.STRING,
        },
        texto: {
            type: DataTypes.TEXT,
        },
        enlace: {
            type: DataTypes.STRING,
        },
        f_comunicado: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        f_baja: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: true,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        vigente: {
            type: DataTypes.BOOLEAN
        }
    },
    {
        createdAt: false,
        updatedAt: false
    }
);

module.exports = comunicadosModel;