const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes, Op } = require('sequelize');
const sysappModel =require('../models/AppsModel');

const menu = dbConection.define('wb_menu',
    {
        id_wb_menu: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_sysapp: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'AppsModel',
                key: 'id_sysapp',
            },
            onDelete: 'RESTRICT',
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
        },
        nombre: {
            type: DataTypes.STRING
        }
    },
    {
        tableName: 'wb_menu',
        timestamps: false
    }
);

// Modelo Sección
const menuLinks = dbConection.define('wb_menu_links', {
    id_wb_menu_link: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_menu: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'menu',
            key: 'id_wb_menu',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    url_link: {
        type: DataTypes.STRING
    },
    link_nivel: {
        type: DataTypes.INTEGER
    },
    url_imagen: {
        type: DataTypes.STRING
    },
    fk_id_cat_type_users: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
    },
    fk_id_wb_menu_link_superior: {
        type:DataTypes.INTEGER
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
    },
    nombre : {
        type:DataTypes.STRING
    },
    id_cat_type_link: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    orden_visible: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false
    },

}, { tableName: 'wb_menu_links',
    timestamps: false });

menu.hasMany(menuLinks, { foreignKey: 'fk_id_wb_menu', as: 'menus' });
menuLinks.belongsTo(menu, { foreignKey: 'fk_id_wb_menu', as: 'menu' });

sysappModel.hasMany(menu, { foreignKey: 'fk_id_sysapp' });
menu.belongsTo(sysappModel, { foreignKey: 'fk_id_sysapp' });

sysappModel.hasMany(menu, { foreignKey: 'fk_id_sysapp' });
menu.belongsTo(sysappModel, { foreignKey: 'fk_id_sysapp' });

module.exports = {
    menu,
    menuLinks
}