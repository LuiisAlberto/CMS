const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const relUserSysappRolesModel = dbConection.define(
  'rel_user_sysapp_roles',
  {
    id_rel_user_sysapp_rol: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    id_cat_rol_sysapp: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    fk_id_user: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    vigente: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    f_reg: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  },
  {
    tableName: 'rel_user_sysapp_roles',
    createdAt: false,
    updatedAt: false,
  }
);

module.exports = relUserSysappRolesModel;
