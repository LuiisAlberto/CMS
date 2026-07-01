const dbConection = require('../config/postgressdb');
const { DataTypes } = require('sequelize');

const HostingModel = dbConection.define('wb_sysapp_hosting', {
  id_hosting: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  fk_id_sysapp: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  fk_id_estatus_hosting: {
    type: DataTypes.SMALLINT,
    allowNull: false,
  },
  dominio_solicitado: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  dominio_asignado: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  solicitado_por: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  f_solicitud: {
    type: 'TIMESTAMP WITHOUT TIME ZONE',
    allowNull: false,
    defaultValue: dbConection.literal('CURRENT_TIMESTAMP'),
  },
  validado_por: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  f_validacion: {
    type: 'TIMESTAMP WITHOUT TIME ZONE',
    allowNull: true,
  },
  f_baja_solicitada: {
    type: 'TIMESTAMP WITHOUT TIME ZONE',
    allowNull: true,
  },
  f_baja: {
    type: 'TIMESTAMP WITHOUT TIME ZONE',
    allowNull: true,
  },
  comentarios: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  paginas_completadas: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  f_paginas_completadas: {
    type: 'TIMESTAMP WITHOUT TIME ZONE',
    allowNull: true,
  },
}, {
  tableName: 'wb_sysapp_hosting',
  timestamps: false,
});

const sysappModel = require('./AppsModel');
const usersModel = require('./users');

HostingModel.belongsTo(sysappModel, { foreignKey: 'fk_id_sysapp', as: 'instancia' });
HostingModel.belongsTo(usersModel, { foreignKey: 'solicitado_por', as: 'solicitante' });

module.exports = HostingModel;

