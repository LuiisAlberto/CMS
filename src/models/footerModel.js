const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes, Op } = require('sequelize');
const sysappModel = require('../models/AppsModel');

// Modelo principal del footer
const footer = dbConection.define('wb_footer',
    {
        id_wb_footer: {
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
        vigente: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
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
            type: DataTypes.STRING,
            allowNull: false,
        },
        url_logo: {
            type: DataTypes.STRING,
        },
        texto_suscripcion: {
            type: DataTypes.TEXT,
        },
        email_contacto: {
            type: DataTypes.STRING,
        },
        telefono_contacto: {
            type: DataTypes.STRING,
        },
        direccion_contacto: {
            type: DataTypes.TEXT,
        },
        texto_copyright: {
            type: DataTypes.STRING,
        }
    },
    {
        tableName: 'wb_footer',
        timestamps: false
    }
);

// Modelo de enlaces de interés del footer
const footerLinks = dbConection.define('wb_footer_links', {
    id_wb_footer_link: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_footer: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_footer',
            key: 'id_wb_footer',
        },
        onDelete: 'CASCADE',
    },
    nombre: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    url_link: {
        type: DataTypes.STRING,
    },
    categoria: {
        type: DataTypes.STRING, // "Documento", "Nuestro Partido", etc.
    },
    orden_visible: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false
    },
    vigente: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
    f_no_vigente: {
        type: 'TIMESTAMP WITHOUT TIME ZONE'
    }
}, {
    tableName: 'wb_footer_links',
    timestamps: false
});

// Relaciones
footer.hasMany(footerLinks, { foreignKey: 'fk_id_wb_footer', as: 'enlaces' });
footerLinks.belongsTo(footer, { foreignKey: 'fk_id_wb_footer', as: 'footer' });

sysappModel.hasMany(footer, { foreignKey: 'fk_id_sysapp' });
footer.belongsTo(sysappModel, { foreignKey: 'fk_id_sysapp' });

module.exports = {
    footer,
    footerLinks
};
