const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes } = require('sequelize');

const storage_files = dbConection.define('storage_files',
    {
        id_storage: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        storage_name: {
            type: DataTypes.STRING,
        },
        storage_path: {
            type: DataTypes.STRING,
        },
        fecha_activo: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        fecha_vence: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
        },
        readonly: {
            type: DataTypes.BOOLEAN,
        },
        activo: {
            type: DataTypes.BOOLEAN,
        },
    }, { tableName: 'storage_files',
        timestamps: false }
);
module.exports = storage_files;