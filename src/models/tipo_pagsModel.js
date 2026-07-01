const dbConection = require('../config/postgressdb');
const { DataTypes, Sequelize} = require('sequelize');

const tipoPaginaModel = dbConection.define('cat_type_pagina',
    {
        id_cat_type_pagina: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        type_pagina: {
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
        f_no_vigente: {
            type: 'TIMESTAMP WITHOUT TIME ZONE'
        }
    },
    {
        createAt: false,
        updateAt: false
    }
);

module.exports = tipoPaginaModel;