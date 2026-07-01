const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const rel_users_sub_moduloModel = dbConection.define('rel_users_sub_modulo',
    {
        id_rel_users_sub_modulo: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_user: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'users',
                key: 'id_user',
            },
            onDelete: 'RESTRICT',
        },
        fk_id_sub_modulo: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'sub_modulo',
                key: 'id_sub_modulo',
            },
            onDelete: 'RESTRICT',
        },
        vigente: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        f_no_vigente: {
            type: 'TIMESTAMP WITHOUT TIME ZONE'
        },
    },
    {
        tableName: 'rel_users_sub_modulo',
        createdAt: false,
        updatedAt: false
    }
);
// rel_users_sub_moduloModel.sync()
// rel_users_sub_moduloModel.sync({ force: true })
module.exports = rel_users_sub_moduloModel;