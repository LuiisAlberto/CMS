const dbConection = require('../config/postgresMain');
const { DataTypes } = require('sequelize');

const HostingStatusModel = dbConection.define('cat_estatus_hosting', {
  id_estatus_hosting: {
    type: DataTypes.SMALLINT,
    primaryKey: true,
  },
  clave: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  descripcion: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  vigente: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'cat_estatus_hosting',
  timestamps: false,
});

module.exports = HostingStatusModel;

