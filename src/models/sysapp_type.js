const dbConection = require('../config/postgressdb');
const { DataTypes } = require('sequelize');

const sysappTypeModel = dbConection.define('sysapp_type', {
    id_sysapp_type: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    type_name: {
        type: DataTypes.STRING,
        allowNull: true,
    },
}, {
    tableName: 'sysapp_type',
    timestamps: false,
});

module.exports = sysappTypeModel;
