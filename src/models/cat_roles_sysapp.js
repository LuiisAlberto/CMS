const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const catRolesSysappModel = dbConection.define(
  'cat_roles_sysapp',
  {
    id_cat_rol_sysapp: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    fk_id_sysapp: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    rol: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    default_sub_modules: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: false,
      defaultValue: [],
    },
    fk_id_cat_type_users: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
    tableName: 'cat_roles_sysapp',
    createdAt: false,
    updatedAt: false,
  }
);

module.exports = catRolesSysappModel;
