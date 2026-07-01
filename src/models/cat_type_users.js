const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');

const cat_type_usersModel = dbConection.define('cat_type_users',
    {
        id_cat_type_users: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            //autoIncrement: true,
            //autoIncrement: true,
        },
        type_user: {
            type: DataTypes.STRING,
        },
        vigente: {
            type: DataTypes.BOOLEAN,
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        }
    },
    {
        createdAt: false,
        updatedAt: false
    }
);
// cat_type_usersModel.sync()
// cat_type_usersModel.sync({ force: true })
module.exports = cat_type_usersModel;