const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const rutasModel = dbConection.define('rutas',
    {
        id_ruta: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        ruta: {
            type: DataTypes.STRING,
        },
        archivo: {
            type: DataTypes.STRING,
        },
        vigente:{
            type: DataTypes.BOOLEAN,
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        view_principal:{
            type: DataTypes.BOOLEAN,
        },
    },
    {
        createdAt: false,
        updatedAt: false
    }
);
// rutasModel.sync()
// rutasModel.sync({ force: true })
module.exports = rutasModel;