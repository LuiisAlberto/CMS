const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes, Op } = require('sequelize');
const util = require('util');


const pagina = dbConection.define('wb_pagina',
    {
        id_wb_pagina: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        nombre_pagina: {
            type: DataTypes.STRING,
        },
        contenido_alt: {
            type: DataTypes.TEXT,
        },
        contenido: {
            type: DataTypes.TEXT,
        },
        fk_id_file: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'files',
                key: 'id_file',
            },
            onDelete: 'RESTRICT',
        },
        fk_id_cat_type_pagina: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'tipoPaginaModel',
                key: 'id_tipo_pags',
            },
            onDelete: 'RESTRICT',
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
        url_safe: {
            type: DataTypes.STRING,
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
        publicada:{
            type: DataTypes.BOOLEAN,
        },
        f_publicacion: {
            type: 'TIMESTAMP WITHOUT TIME ZONE'
        },
    },
    {
        tableName: 'wb_pagina',
        timestamps: false
    }
);

// Modelo Sección
const seccion = dbConection.define('wb_pag_seccion', {
    id_wb_pag_seccion: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_wb_visible:{
        type:DataTypes.ARRAY(DataTypes.INTEGER)
    },
    wb_margin: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
    },
    wb_padding: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
    },
    fk_id_cat_wb_width: {
        type:DataTypes.INTEGER
    },
    wb_num_col: {
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
    orden_visible: {
        type: DataTypes.INTEGER
    }
}, { tableName: 'wb_pag_seccion',
    timestamps: false });
pagina.hasMany(seccion, { foreignKey: 'fk_id_wb_pagina', as: 'secciones' });
seccion.belongsTo(pagina, { foreignKey: 'fk_id_wb_pagina', as: 'seccion' });

/**
 * Intercambia `orden_visible` en `wb_pag_seccion` entre una sección y la inmediata arriba o abajo.
 * @param {number|string} idpag
 * @param {number|string} idsec  id_wb_pag_seccion
 * @param {'up'|'down'} direction
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<{ success: true, ordenes: Array<{ id_wb_pag_seccion: number, orden_visible: number }> } | { success: false, status: number, message: string }>}
 */
async function intercambiarOrdenSeccionesAdyacentes(idpag, idsec, direction, transaction) {
    const pid = parseInt(idpag, 10);
    const sid = parseInt(idsec, 10);
    if (!pid || !sid || (direction !== 'up' && direction !== 'down')) {
        return { success: false, status: 400, message: 'Parámetros inválidos.' };
    }

    const secciones = await seccion.findAll({
        where: { fk_id_wb_pagina: pid, vigente: true },
        order: [['orden_visible', 'ASC'], ['id_wb_pag_seccion', 'ASC']],
        transaction
    });

    const idx = secciones.findIndex((s) => s.id_wb_pag_seccion === sid);
    if (idx === -1) {
        return { success: false, status: 404, message: 'La sección no existe en esta página.' };
    }

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= secciones.length) {
        return {
            success: false,
            status: 400,
            message: direction === 'up'
                ? 'La sección ya está arriba del todo.'
                : 'La sección ya está abajo del todo.'
        };
    }

    const a = secciones[idx];
    const b = secciones[swapIdx];
    const ordenA = a.orden_visible;
    const ordenB = b.orden_visible;

    await seccion.update(
        { orden_visible: ordenB },
        { where: { id_wb_pag_seccion: a.id_wb_pag_seccion }, transaction }
    );
    await seccion.update(
        { orden_visible: ordenA },
        { where: { id_wb_pag_seccion: b.id_wb_pag_seccion }, transaction }
    );

    return {
        success: true,
        ordenes: [
            { id_wb_pag_seccion: a.id_wb_pag_seccion, orden_visible: ordenB },
            { id_wb_pag_seccion: b.id_wb_pag_seccion, orden_visible: ordenA }
        ]
    };
}

// Modelo Columna
const columna = dbConection.define('wb_pag_columna', {
    id_wb_pag_columna: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_seccion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_seccion',
            key: 'id_wb_pag_seccion',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_wb_visible: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
    },
    wb_padding: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
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
    orden_visible: {
        type: DataTypes.INTEGER
    }
}, { tableName: 'wb_pag_columna',
    timestamps: false });
seccion.hasMany(columna, { foreignKey: 'fk_id_wb_pag_seccion', as: 'columnas' });
columna.belongsTo(seccion, { foreignKey: 'fk_id_wb_pag_seccion', as: 'columna' });

// Modelo Componente
const componente = dbConection.define('wb_pag_componente', {
    id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_columna: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_columna',
            key: 'id_wb_pag_columna',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_wb_visible: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
    },
    wb_padding: {
        type: DataTypes.ARRAY(DataTypes.INTEGER)
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
    fk_id_cat_wb_componente: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'cat_wb_componente',
            key: 'id_cat_wb_componente',
        },
        onDelete: 'RESTRICT',
    },
    orden_visible: {
        type: DataTypes.INTEGER
    }
}, { tableName: 'wb_pag_componente',
    timestamps: false });
columna.hasMany(componente, { foreignKey: 'fk_id_wb_pag_columna', as: 'componentes' });
componente.belongsTo(columna, { foreignKey: 'fk_id_wb_pag_columna', as: 'componente' });

const tipoComponente = dbConection.define('cat_wb_type_componentes', {
    id_cat_wb_componente: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    type_componente: {
        type: DataTypes.STRING
    },
    table_componente: {
        type: DataTypes.STRING
    },
    shortcut: {
        type: DataTypes.STRING
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
    has_file: {
        type: DataTypes.BOOLEAN,
    },
    icon_comp: {
        type: DataTypes.STRING
    }
}, { tableName: 'cat_wb_type_componentes',
    timestamps: false });
componente.belongsTo(tipoComponente, { foreignKey: 'fk_id_cat_wb_componente', as: 'tipoComponente' });
tipoComponente.hasMany(componente, { foreignKey: 'fk_id_cat_wb_componente', as: 'componentes' });

const wb_comp_titulopag = dbConection.define('wb_comp_titulopag', {
    id_wb_comp_titulopag: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    texto: {
        type: DataTypes.STRING
    },
    fk_id_file: {
        type: DataTypes.INTEGER
    },
    fk_id_file_izq: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    color_filtro: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: '#8B0000'
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
}, { tableName: 'wb_comp_titulopag',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_titulopag, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_titulopag'  });
wb_comp_titulopag.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_titulopag'  });

const wb_comp_subtitulo = dbConection.define('wb_comp_subtitulo', {
    id_wb_comp_subtitulo: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    texto: {
        type: DataTypes.STRING
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
}, { tableName: 'wb_comp_subtitulo',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_subtitulo, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_subtitulo'  });
wb_comp_subtitulo.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_subtitulo'  });

const wb_comp_texto = dbConection.define('wb_comp_texto', {
    id_wb_comp_texto: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    texto: {
        type: DataTypes.STRING
    },
    wb_padding: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
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
}, { tableName: 'wb_comp_texto',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_texto, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_texto'  });
wb_comp_texto.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_texto'  });

const wb_comp_boton = dbConection.define('wb_comp_boton', {
    id_wb_comp_boton: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    texto: {
        type: DataTypes.STRING
    },
    liga: {
        type: DataTypes.STRING
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
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
}, { tableName: 'wb_comp_boton',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_boton, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_boton'  });
wb_comp_boton.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_boton'  });

const cat_type_carrousel = dbConection.define('cat_type_carrousel', {
    id_cat_carrousel: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    type_carrousel: {
        type: DataTypes.STRING,
    },
    vigente: {
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
}, { tableName: 'cat_type_carrousel',
    timestamps: false });

const wb_comp_carrousel = dbConection.define('wb_comp_carrousel', {
    id_wb_comp_carrousel: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_type_carrousel: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_type_carrousel',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    color_acento: {
        type: DataTypes.STRING(7),
        allowNull: true,
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
}, { tableName: 'wb_comp_carrousel',
    freezeTableName: true,
    timestamps: false,
    }
);

const wb_comp_slides_carrousel = dbConection.define('wb_comp_slides_carrousel', {
    id_wb_comp_slides_carrousel: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_comp_carrousel: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_comp_carrousel',
            key: 'id_wb_comp_carrousel',
        },
        onDelete: 'RESTRICT',
    },
    titulo:{
        type: DataTypes.TEXT,
    },
    texto:{
        type: DataTypes.TEXT,
    },
    btn_text: {
        type: DataTypes.STRING,
    },
    url_link:{
        type: DataTypes.STRING,
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_file:{
        type: DataTypes.ARRAY(DataTypes.STRING),
    },
    type_slide: {
        type: DataTypes.INTEGER,
        defaultValue: 1, // 1 = layout básico por defecto
        allowNull: false
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
    orden_visible: {
        type: DataTypes.INTEGER
    }
}, { tableName: 'wb_comp_slides_carrousel',
    freezeTableName: true,
    timestamps: false,
    defaultScope: {  order: [['id_wb_comp_slides_carrousel', 'ASC']] }
    }
);
componente.hasMany(wb_comp_carrousel, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_carrousel'  });
wb_comp_carrousel.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_carrousel'  });
wb_comp_carrousel.hasMany(wb_comp_slides_carrousel, { foreignKey: 'fk_id_wb_comp_carrousel', as: 'wb_comp_slides_carrousel'  });
wb_comp_slides_carrousel.belongsTo(wb_comp_carrousel, { foreignKey: 'fk_id_wb_comp_carrousel', as: 'wb_comp_slides_carrousel'  });
// wb_comp_slides_carrousel

const wb_comp_tabs = dbConection.define('wb_comp_tabs', {
    id_wb_comp_tabs: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
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
}, { tableName: 'wb_comp_tabs',
    freezeTableName: true,
    timestamps: false });
const wb_comp_tab_tabs = dbConection.define('wb_comp_tab_tabs', {
    id_wb_comp_tab_tabs: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_comp_tabs: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_comp_tabs',
            key: 'id_wb_comp_tabs',
        },
        onDelete: 'RESTRICT',
    },
    titulo:{
        type: DataTypes.TEXT,
    },
    texto:{
        type: DataTypes.TEXT,
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
}, { tableName: 'wb_comp_tab_tabs',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_tabs, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_tabs'  });
wb_comp_tabs.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_tabs'  });
wb_comp_tabs.hasMany(wb_comp_tab_tabs, { foreignKey: 'fk_id_wb_comp_tabs', as: 'wb_comp_tab_tabs'  });
wb_comp_tab_tabs.belongsTo(wb_comp_tabs, { foreignKey: 'fk_id_wb_comp_tabs', as: 'wb_comp_tab_tabs'  });
// wb_comp_tab_tabs

const wb_comp_flip = dbConection.define('wb_comp_flip', {
    id_wb_comp_flip: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.TEXT
    },
    texto: {
        type: DataTypes.TEXT
    },
    url_link: {
        type: DataTypes.STRING
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_file: {
        type: DataTypes.INTEGER,
    },
    color_acento: {
        type: DataTypes.STRING(7),
        allowNull: true,
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
}, { tableName: 'wb_comp_flip',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_flip, { foreignKey: 'fk_id_wb_pag_componente', as:'wb_comp_flip' });
wb_comp_flip.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as:'wb_comp_flip'  });

const wb_comp_noticias = dbConection.define('wb_comp_noticias', {
    id_wb_comp_noticias: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
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
    }
}, { tableName: 'wb_comp_noticias',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_noticias, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_noticias'  });
wb_comp_noticias.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_noticias'  });

const wb_comp_galeria = dbConection.define('wb_comp_galeria', {
    id_wb_comp_galeria: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
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
}, { tableName: 'wb_comp_galeria',
    freezeTableName: true,
    timestamps: false });
const wb_comp_slides_galeria = dbConection.define('wb_comp_slides_galeria', {
    id_wb_comp_slides_galeria: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_comp_galeria: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_comp_galeria',
            key: 'id_wb_comp_galeria',
        },
        onDelete: 'RESTRICT',
    },
    titulo:{
        type: DataTypes.TEXT,
    },
    texto:{
        type: DataTypes.TEXT,
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_file:{
        type: DataTypes.ARRAY(DataTypes.STRING),
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
    orden_visible: {
        type: DataTypes.INTEGER
    }
}, { tableName: 'wb_comp_slides_galeria',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_galeria, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_galeria'  });
wb_comp_galeria.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_galeria'  });
wb_comp_galeria.hasMany(wb_comp_slides_galeria, { foreignKey: 'fk_id_wb_comp_galeria', as: 'wb_comp_slides_galeria'  });
wb_comp_slides_galeria.belongsTo(wb_comp_galeria, { foreignKey: 'fk_id_wb_comp_galeria', as: 'wb_comp_slides_galeria'  });
// wb_comp_slides_galeria

const wb_comp_galeria_tag = dbConection.define('wb_comp_galeria_tag', {
    id_wb_comp_galeria_tag: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.TEXT
    },
    texto: {
        type: DataTypes.TEXT
    },

    fk_id_cat_wb_type_content_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_wb_type_content_tag',
            key: 'id_cat_wb_type_content_tag',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_tag',
            key: 'id_cat_tag',
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
},  { tableName: 'wb_comp_galeria_tag',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_galeria_tag, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_galeria_tag' });
wb_comp_galeria_tag.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_galeria_tag' });

const wb_comp_cards_regeneracion = dbConection.define('wb_comp_cards_regeneracion', {
    id_wb_comp_cards_regeneracion: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_wb_type_content_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_wb_type_content_tag',
            key: 'id_cat_wb_type_content_tag',
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
    anio_seleccionado: {
        type: DataTypes.INTEGER,
    }
}, { tableName: 'wb_comp_cards_regeneracion',
    timestamps: false });
componente.hasMany(wb_comp_cards_regeneracion, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_cards_regeneracion'  });
wb_comp_cards_regeneracion.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_cards_regeneracion'  });

const cat_bimestres = dbConection.define('cat_bimestres', {
    id_cat_bimestres: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    bimestre: {
        type: DataTypes.TEXT,
    },
    num_bimestre: {
        type: DataTypes.INTEGER,
    },
    vigente: {
        type: DataTypes.BOOLEAN,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    }
}, { tableName: 'cat_bimestres',
    timestamps: false });

// Modelo wb_contenedor_acordeon
const wb_contenedor_acordeon = dbConection.define('wb_contenedor_acordeon', {
    id_wb_contenedor_acordeon: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    descripcion: {
        type: DataTypes.STRING,
    },
    vigente: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    publicada: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    }
}, { tableName: 'wb_contenedor_acordeon',
    timestamps: false
});

// Modelo wb_categoria_acordeon (tab = categoría de documentos, puede vincularse a cat_tag)
const wb_categoria_acordeon = dbConection.define('wb_categoria_acordeon', {
    id_wb_categoria_acordeon: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    descripcion: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'cat_tags', key: 'id_cat_tag' },
        onDelete: 'SET NULL',
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_wb_contenedor_acordeon: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_contenedor_acordeon',
            key: 'id_wb_contenedor_acordeon',
        },
        onDelete: 'RESTRICT',
    },
    activo: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    }
}, { tableName: 'wb_categoria_acordeon',
    timestamps: false
});

const wb_comp_direccion = dbConection.define('wb_comp_direccion', {
    id_wb_comp_direccion: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.TEXT
    },
    texto: {
        type: DataTypes.TEXT
    },
    coordenadas: {
        type: DataTypes.STRING
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
}, { tableName: 'wb_comp_direccion',
    timestamps: false });
componente.hasMany(wb_comp_direccion, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_direccion'  });
wb_comp_direccion.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_direccion'  });

const wb_comp_redes = dbConection.define('wb_comp_redes', {
    id_wb_comp_redes: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    facebook: {
        type: DataTypes.TEXT
    },
    facebook_link: {
        type: DataTypes.TEXT
    },
    instagram: {
        type: DataTypes.TEXT
    },
    instagram_link: {
        type: DataTypes.TEXT
    },
    tiktok: {
        type: DataTypes.TEXT
    },
    tiktok_link: {
        type: DataTypes.TEXT
    },
    x_twitter: {
        type: DataTypes.TEXT
    },
    x_twitter_link: {
        type: DataTypes.TEXT
    },
    yt: {
        type: DataTypes.TEXT
    },
    yt_link: {
        type: DataTypes.TEXT
    },
    color_acento: {
        type: DataTypes.STRING(7),
        allowNull: true,
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
}, { tableName: 'wb_comp_redes',
    freezeTableName: true,
    timestamps: false });
componente.hasMany(wb_comp_redes, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_redes'  });
wb_comp_redes.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_redes'  });

const wb_comp_acordeon = dbConection.define('wb_comp_acordeon', {
    id_wb_comp_acordeon: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_rel_wb_subcategoria: {
        type: DataTypes.INTEGER,
    },
    fk_id_wb_doc: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'wb_docs', key: 'id_wb_doc' },
        onDelete: 'SET NULL',
    },
    titulo: {
        type: DataTypes.TEXT
    },
    texto: {
        type: DataTypes.TEXT
    },
    url_link: {
        type: DataTypes.TEXT
    },
    fk_id_cat_wb_type_content_tag: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: true,
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
    span_color: {
        type: DataTypes.TEXT
    }
}, { tableName: 'wb_comp_acordeon',
    timestamps: false,
        defaultScope: {  order: [['id_wb_comp_acordeon', 'ASC']] } });
componente.hasMany(wb_comp_acordeon, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_acordeon'  });
wb_comp_acordeon.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_acordeon'  });

const wb_comp_cards = dbConection.define('wb_comp_cards', {
    id_wb_comp_cards: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.TEXT
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
    url_link: {
        type: DataTypes.STRING
    },
    fk_id_file: {
    type: DataTypes.INTEGER,
    references: {
            model: 'files',
            key: 'id_file',
        },
    }
}, { tableName: 'wb_comp_cards',
    timestamps: false });

componente.hasMany(wb_comp_cards, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_cards'  });
wb_comp_cards.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_cards'  });


const wb_comp_linea = dbConection.define('wb_comp_linea', {
    id_wb_comp_linea: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
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
}, { tableName: 'wb_comp_linea',
    timestamps: false });
const wb_comp_slides_linea = dbConection.define('wb_comp_slides_linea', {
    id_wb_comp_slides_linea: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_comp_linea: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_comp_linea',
            key: 'id_wb_comp_linea',
        },
        onDelete: 'RESTRICT',
    },
    separador:{
        type: DataTypes.TEXT,
    },
    titulo:{
        type: DataTypes.TEXT,
    },
    texto:{
        type: DataTypes.TEXT,
    },
    fk_id_file:{
        type: DataTypes.ARRAY(DataTypes.STRING),
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
    orden_visible: {
        type: DataTypes.INTEGER
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
}, { tableName: 'wb_comp_slides_linea',
    timestamps: false });
componente.hasMany(wb_comp_linea, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_linea'});
wb_comp_linea.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_linea' });
wb_comp_linea.hasMany(wb_comp_slides_linea, { foreignKey: 'fk_id_wb_comp_linea', as: 'wb_comp_slides_linea'  });
wb_comp_slides_linea.belongsTo(wb_comp_linea, { foreignKey: 'fk_id_wb_comp_linea', as: 'wb_comp_slides_linea'  });

const wb_comp_lista_tags = dbConection.define('wb_comp_lista_tags', {
    id_wb_comp_lista_tags: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
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
    fk_id_cat_wb_type_content_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_wb_type_content_tag',
            key: 'id_cat_wb_type_content_tag',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_tags',
            key: 'id_cat_tag',
        },
        onDelete: 'RESTRICT',
    }
},{ tableName: 'wb_comp_lista_tags',
    timestamps: false });
componente.hasMany(wb_comp_lista_tags, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_lista_tags' });
wb_comp_lista_tags.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_lista_tags' });

const wb_comp_img = dbConection.define('wb_comp_img', {
    id_wb_comp_img: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_file: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'files',
            key: 'id_file',
        },
        onDelete: 'RESTRICT',
    },
    url_link: {
        type: DataTypes.STRING
    },
    wb_padding: {
        type:DataTypes.ARRAY(DataTypes.INTEGER)
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
},{ tableName: 'wb_comp_img',
    timestamps: false });
componente.hasMany(wb_comp_img, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_img' });
wb_comp_img.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_img' });

const wb_comp_personas = dbConection.define('wb_comp_personas', {
    id_wb_comp_personas: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_file: {
        type: DataTypes.INTEGER
    },
    titulo: {
        type: DataTypes.TEXT
    },
    texto: {
        type: DataTypes.TEXT
    },
    color_acento: {
        type: DataTypes.STRING(7),
        allowNull: true,
    },
    vigente: {
        type: DataTypes.BOOLEAN,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
    f_no_vigente: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
    }
}, { tableName: 'wb_comp_personas',
    timestamps: false, 
    defaultScope: {  order: [['id_wb_comp_personas', 'ASC']] } });
componente.hasMany(wb_comp_personas, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_personas' });
wb_comp_personas.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_personas' });

const wb_comp_video = dbConection.define('wb_comp_video', {
    id_wb_comp_video: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_file: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'files',
            key: 'id_file',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.TEXT
    },
    f_video: {
        type: 'TIMESTAMP WITHOUT TIME ZONE'
    },
    url_link: {
        type: DataTypes.STRING
    },
    vigente: {
        type: DataTypes.BOOLEAN,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
    f_no_vigente: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
    }
}, { tableName: 'wb_comp_video',
    timestamps: false });
componente.hasMany(wb_comp_video, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_video' });
wb_comp_video.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_video' });

const wb_comp_coleccion_fotografica = dbConection.define('wb_comp_coleccion_fotografica', {
    id_wb_comp_coleccion_fotografica: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_wb_type_content_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_wb_type_content_tag',
            key: 'id_cat_wb_type_content_tag',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_tag',
            key: 'id_cat_tag',
        },
        onDelete: 'RESTRICT',
    },
    vigente: {
        type: DataTypes.BOOLEAN,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
    f_no_vigente: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
    },
}, { tableName: 'wb_comp_coleccion_fotografica',
    timestamps: false });
componente.hasMany(wb_comp_coleccion_fotografica, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_coleccion_fotografica' });
wb_comp_coleccion_fotografica.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_coleccion_fotografica' });

const wb_comp_coleccion_docs = dbConection.define('wb_comp_coleccion_docs', {
    id_wb_wb_comp_coleccion_docs: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_pag_componente: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pag_componente',
            key: 'id_wb_pag_componente',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.TEXT
    },
    texto: {
        type: DataTypes.TEXT
    },
    fk_id_cat_wb_type_content_tag: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    fk_id_cat_tag: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        allowNull: true
    },
    vigente: {
        type: DataTypes.BOOLEAN,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
    f_no_vigente: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
    },
}, { tableName: 'wb_comp_coleccion_docs',
    timestamps: false });

componente.hasMany(wb_comp_coleccion_docs, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_coleccion_docs' });
wb_comp_coleccion_docs.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_coleccion_docs' });

const wb_comp_tablas = dbConection.define('wb_comp_tablas', {
    
});
componente.hasMany(wb_comp_tablas, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_tablas' });
wb_comp_tablas.belongsTo(componente, { foreignKey: 'fk_id_wb_pag_componente', as: 'wb_comp_tablas' });

// documentos
const documento = dbConection.define('wb_docs',
    {
        id_wb_doc: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        nombre: {
            type: DataTypes.STRING,
        },
        contenido_alt: {
            type: DataTypes.TEXT,
        },
        fk_id_file: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'files',
                key: 'id_file',
            },
            onDelete: 'RESTRICT',
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
        fk_id_sysapp: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'AppsModel',
                key: 'id_sysapp',
            },
            onDelete: 'RESTRICT',
        },
        f_publicacion: {
            type: 'TIMESTAMP WITHOUT TIME ZONE'
        },
    },
    {
        tableName: 'wb_docs',
        timestamps: false
    }
);

// imagenes
const imagen = dbConection.define('wb_imgs', 
    {
        id_wb_img:{
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        nombre: {
            type: DataTypes.STRING,
        },
        contenido_alt: {
            type: DataTypes.TEXT,
        },
        fk_id_file: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'files',
                key: 'id_file',
            },
            onDelete: 'RESTRICT',
        },
        fk_id_cat_type_imgs: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'cat_type_imgs',
                key: 'id_cat_type_imgs',
            },
            onDelete: 'SET NULL',
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
        vigente: {
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
        fk_id_sysapp: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'AppsModel',
                key: 'id_sysapp',
            },
            onDelete: 'RESTRICT',
        },
        f_publicacion: {
            type: 'TIMESTAMP WITHOUT TIME ZONE'
        }
    },
    {
        tableName: 'wb_imgs',
        timestamps: false
    }
);

const rel_wb_subcategoria = dbConection.define('rel_wb_subcategoria', {
    id_rel_wb_subcategoria: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_wb_categoria_acordeon: {
        type: DataTypes.INTEGER,
        references: {
            model: 'wb_categoria_acordeon',
            key: 'id_wb_categoria_acordeon',
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
    fk_id_wb_contenedor_acordeon: {
        type: DataTypes.INTEGER,
        references: {
            model: 'wb_contenedor_acordeon',
            key: 'id_wb_contenedor_acordeon',
        },
        onDelete: 'RESTRICT',
    },
    titulo: {
        type: DataTypes.STRING,
    },
    vigente: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    }
}, { tableName: 'rel_wb_subcategoria',
    timestamps: false
});

// PARA LAS RELACIONES DE TAGS
const rel_wb_tag_pagina = dbConection.define('rel_wb_tag_pagina', {
    id_rel_wb_tag_pagina: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_tags',
            key: 'id_cat_tag',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_wb_pagina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_user: {
        type: DataTypes.INTEGER
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
}, { tableName: 'rel_wb_tag_pagina',
    timestamps: false });
const rel_wb_tag_doc = dbConection.define('rel_wb_tag_doc', {
    id_rel_wb_tag_doc: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_tags',
            key: 'id_cat_tag',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_wb_doc: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_docs',
            key: 'id_wb_docs',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_user: {
        type: DataTypes.INTEGER
    },
    anio: {
        type: DataTypes.INTEGER,
    },
    fk_id_cat_bimestre: {
        type: DataTypes.INTEGER,
        references: {
            model: 'cat_bimestres',
            key: 'id_cat_bimestres',
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
}, { tableName: 'rel_wb_tag_doc',
    timestamps: false });
const rel_wb_tag_img = dbConection.define('rel_wb_tag_img', {
    id_rel_wb_tag_img: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_cat_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_tags',
            key: 'id_cat_tag',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_wb_img: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_imgs',
            key: 'id_wb_img',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_user: {
        type: DataTypes.INTEGER
    },
    vigente: {
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
}, {
    tableName: 'rel_wb_tag_img',
    timestamps: false });

const cat_tags = dbConection.define('cat_tags', {
    id_cat_tag: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_id_cat_type_tag: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_type_tags',
            key: 'id_cat_type_tag',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_sysapp_type: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    tag: {
        type: DataTypes.STRING,
    },
    descripcion_tag: {
        type: DataTypes.TEXT,
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
}, { tableName: 'cat_tags',
    timestamps: false });
const cat_wb_type_content_tag = dbConection.define('cat_wb_type_content_tag',{
    id_cat_wb_type_content_tag: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    type_content_tag: {
        type: DataTypes.STRING,
    }
}, { tableName: 'cat_wb_type_content_tag',
    timestamps: false
});
const cat_type_tags = dbConection.define('cat_type_tags', {
    id_cat_type_tag: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    cat_type_tag: {
        type: DataTypes.STRING,
    },
    vigente: {
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
}, { tableName: 'cat_type_tags', 
    timestamps: false});
// Relación de páginas editadas
const rel_wb_pag_borrador = dbConection.define('rel_wb_pag_borrador', {
    id_rel_wb_pag_borrador: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    fk_pag_origen: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_pag_nueva: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'wb_pagina',
            key: 'id_wb_pagina',
        },
        onDelete: 'RESTRICT',
    },
    fk_id_cat_pag_tipo_borrador: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'cat_pag_tipo_duplicado',
            key: 'id_cat_pag_tipo_borrador',
        },
        onDelete: 'RESTRICT',
    },
    f_reg: {
        type: 'TIMESTAMP WITHOUT TIME ZONE',
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
    vigente: {
        type: DataTypes.BOOLEAN,
    },
}, {
    tableName: 'rel_wb_pag_borrador',
    timestamps: false
});

documento.belongsToMany(cat_tags, {  through: rel_wb_tag_doc,
    foreignKey: 'fk_id_wb_doc',
    otherKey: 'fk_id_cat_tag'
});
cat_tags.belongsToMany(documento, { through: rel_wb_tag_doc,
    foreignKey: 'fk_id_cat_tag',
    otherKey: 'fk_id_wb_doc',
});


// Agregar estas asociaciones directas
rel_wb_tag_doc.belongsTo(documento, {
    foreignKey: 'fk_id_wb_doc',
    as: 'documento'
});

documento.hasMany(rel_wb_tag_doc, {
    foreignKey: 'fk_id_wb_doc',
    as: 'tag_relations'
});

wb_comp_acordeon.belongsTo(documento, { foreignKey: 'fk_id_wb_doc', as: 'documento' });
documento.hasMany(wb_comp_acordeon, { foreignKey: 'fk_id_wb_doc', as: 'acordeonRefs' });

// También para las imágenes, si es necesario
rel_wb_tag_doc.belongsTo(imagen, {
    foreignKey: 'fk_id_wb_doc', // Ajusta si es necesario
    as: 'imagen'
});

// componente.belongsToMany(cat_tags, { through: rel_wb_tag_pagina, 
//     foreignKey: 'fk_id_cat_tag', 
//     as: 'cat_tags',
//  });

imagen.belongsToMany(cat_tags, { through: rel_wb_tag_img,
    foreignKey: 'fk_id_wb_img',
    otherKey: 'fk_id_cat_tag'
});

cat_tags.belongsToMany(imagen, { through: rel_wb_tag_img,
    foreignKey: 'fk_id_cat_tag',
    otherKey: 'fk_id_wb_img'
});

wb_comp_coleccion_fotografica.belongsTo(cat_tags, {
    foreignKey: 'fk_id_cat_tag',
    as: 'cat_tag'
});
cat_tags.hasMany(wb_comp_coleccion_fotografica, {
    foreignKey: 'fk_id_cat_tag',
    as: 'colecciones_fotograficas'
});

wb_categoria_acordeon.belongsTo(cat_tags, { foreignKey: 'fk_id_cat_tag', as: 'cat_tag' });
cat_tags.hasMany(wb_categoria_acordeon, { foreignKey: 'fk_id_cat_tag', as: 'categoriasAcordeon' });


pagina.belongsToMany(cat_tags, {
    through: rel_wb_tag_pagina,
    foreignKey: 'fk_id_wb_pagina',
    otherKey: 'fk_id_cat_tag',
});
pagina.hasOne(rel_wb_pag_borrador, {
    foreignKey: 'fk_pag_nueva',
    as: 'duplicado'
});
pagina.hasMany(rel_wb_pag_borrador, {
    foreignKey: 'fk_pag_origen',
    as: 'hijos_duplicados'
});
pagina.hasOne(rel_wb_pag_borrador, {
    foreignKey: 'fk_pag_origen',
    as: 'borrador_existente'
});
cat_tags.belongsToMany(pagina, { through: rel_wb_tag_pagina,
    foreignKey: 'fk_id_cat_tag',
    otherKey: 'fk_id_wb_pagina',
});

pagina.getDataPagina = async (id_sysapp,uri_pag, type_uri) => {
    let paginas = await pagina.findAll({
        where: {
            url_safe: uri_pag,
            fk_id_sysapp: id_sysapp,
            vigente: true,
            publicada:true,
            fk_id_cat_type_pagina: type_uri
        },
        include: [{
            model: seccion,
            as: 'secciones',
            required: false,
            where: { vigente: true },
            include: [{
                model: columna,
                as: 'columnas',
                required: false,
                where: { vigente: true },
                include: [{
                    model: componente,
                    as:'componentes',
                    required: false,
                    where: { vigente: true },
                    include: [{
                        model: tipoComponente,
                        as:'tipoComponente',
                        required: false,
                        where: { vigente: true },
                    }],
                }],
            }],
        }],
        subQuery: false,
        order: [
            ['id_wb_pagina', 'DESC'],
            Sequelize.literal('secciones.orden_visible ASC,"secciones->columnas".orden_visible ASC, "secciones->columnas->componentes".orden_visible ASC, "secciones->columnas->componentes".id_wb_pag_componente ASC')
        ],
        // logging: // console.log
    });

    // Iterar sobre la estructura para poblar acordeones
    for (let pag of paginas) {
        if (pag.secciones) {
            for (let sec of pag.secciones) {
                if (sec.columnas) {
                    for (let col of sec.columnas) {
                        if (col.componentes) {
                            for (let comp of col.componentes) {
                                if (comp.tipoComponente && comp.tipoComponente.table_componente === 'wb_comp_acordeon') {
                                    // Lógica manual para acordeón
                                    let contenedor = await wb_contenedor_acordeon.findAll({
                                        where: {
                                            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
                                            vigente: true,
                                        },
                                        raw: true,
                                    });

                                    for (let cont of contenedor) {
                                        const categorias = await wb_categoria_acordeon.findAll({
                                            where: {
                                                fk_id_wb_contenedor_acordeon: cont.id_wb_contenedor_acordeon,
                                                activo: true
                                            },
                                            raw: true
                                        });
                                        cont.categorias = categorias;

                                        for (let cat of categorias) {
                                            const subcategorias = await rel_wb_subcategoria.findAll({
                                                where: {
                                                    fk_id_wb_categoria_acordeon: cat.id_wb_categoria_acordeon,
                                                    vigente: true
                                                },
                                                raw: true
                                            });
                                            cat.subcategorias = subcategorias;

                                            for (let sub of subcategorias) {
                                                const acordeonesRows = await wb_comp_acordeon.findAll({
                                                    where: {
                                                        fk_id_rel_wb_subcategoria: sub.id_rel_wb_subcategoria,
                                                        vigente: true
                                                    },
                                                    include: [{
                                                        model: documento,
                                                        as: 'documento',
                                                        required: false,
                                                        attributes: ['id_wb_doc', 'nombre'],
                                                        include: [{
                                                            model: require('../models/files').files,
                                                            as: 'archivodoc',
                                                            required: false,
                                                            attributes: ['file_path'],
                                                            include: [{
                                                                model: require('../models/storage_files'),
                                                                as: 'storage',
                                                                required: false,
                                                                attributes: ['storage_path']
                                                            }]
                                                        }]
                                                    }]
                                                });
                                                const acordeones = acordeonesRows.map(a => {
                                                    const plain = a.get ? a.get({ plain: true }) : a;
                                                    let link = plain.url_link || null;
                                                    if (plain.documento && plain.documento.archivodoc) {
                                                        const st = (plain.documento.archivodoc.storage || {});
                                                        link = (st.storage_path || '') + (plain.documento.archivodoc.file_path || '');
                                                        if (link && !/^https?:\/\//i.test(link)) link = 'https://cdn.morena.app/' + link.replace(/^\//, '');
                                                    }
                                                    return {
                                                        id_wb_comp_acordeon: plain.id_wb_comp_acordeon,
                                                        titulo: plain.titulo || (plain.documento ? plain.documento.nombre : ''),
                                                        texto: plain.texto,
                                                        url_link: link,
                                                        link: link
                                                    };
                                                });
                                                sub.acordeones = acordeones;
                                            }
                                        }
                                    }
                                    // Asignar al componente
                                    comp.dataValues.contenedor_acordeon = contenedor;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return paginas;
}
pagina.getDataPaginaID = async (id_wb_pagina) => {
    return await pagina.findAll({
        where: {
            id_wb_pagina:id_wb_pagina,
            vigente: true,
        },
        include: [{
            model: seccion,
            as: 'secciones',
            required: false,
            where: { vigente: true },
            include: [{
                model: columna,
                as: 'columnas',
                required: false,
                where: { vigente: true },
                include: [{
                    model: componente,
                    as:'componentes',
                    required: false,
                    where: { vigente: true },
                    include: [{
                        model: tipoComponente,
                        as:'tipoComponente',
                        required: false,
                        where: { vigente: true },
                    }],
                }],
            }],
        }],
        subQuery: false,
        order: Sequelize.literal('secciones.orden_visible ASC,"secciones->columnas".orden_visible ASC, "secciones->columnas->componentes".orden_visible ASC, "secciones->columnas->componentes".id_wb_pag_componente ASC'),
        // logging: // console.log
    });
}

componente.getComponente = async ( tabla, id_componente, idapp) => {
    try {
        const Modelpadre = dbConection.models[tabla];
        if (!Modelpadre) {
            throw new Error(`El modelo para la tabla '${tabla}' no está definido.`);
        }

        // Query básico sin includes complejos
        let componentedata = await componente.findOne({
            where: {
                id_wb_pag_componente: id_componente,
                vigente: true,
            },
            include: [
                {
                    model: Modelpadre,
                    as: tabla,
                    required: false,
                    where: { vigente: true }
                },
                // Incluir wb_comp_img si existe la relación (para componentes de imagen)
                {
                    model: wb_comp_img,
                    as: 'wb_comp_img',
                    required: false,
                    where: { vigente: true }
                }
            ],
        });

        // Si es wb_comp_acordeon, hacer los joins manualmente
        if (tabla === 'wb_comp_acordeon' && componentedata) {
            let contenedor = await wb_contenedor_acordeon.findAll({
                where: {
                    fk_id_wb_pag_componente: id_componente,
                    vigente: true,
                },
                raw: true,
            });

            for (let cont of contenedor) {
                const categorias = await wb_categoria_acordeon.findAll({
                    where: {
                        fk_id_wb_contenedor_acordeon: cont.id_wb_contenedor_acordeon,
                        activo: true
                    },
                    raw: true
                });
                cont.categorias = categorias;

                for (let cat of categorias) {
                    const subcategorias = await rel_wb_subcategoria.findAll({
                        where: {
                            fk_id_wb_categoria_acordeon: cat.id_wb_categoria_acordeon,
                            vigente: true
                        },
                        raw: true
                    });
                    cat.subcategorias = subcategorias;

                    for (let sub of subcategorias) {
                        const acordeonesRows = await wb_comp_acordeon.findAll({
                            where: {
                                fk_id_rel_wb_subcategoria: sub.id_rel_wb_subcategoria,
                                vigente: true
                            },
                            include: [{
                                model: documento,
                                as: 'documento',
                                required: false,
                                attributes: ['id_wb_doc', 'nombre'],
                                include: [{
                                    model: require('../models/files').files,
                                    as: 'archivodoc',
                                    required: false,
                                    attributes: ['file_path'],
                                    include: [{
                                        model: require('../models/storage_files'),
                                        as: 'storage',
                                        required: false,
                                        attributes: ['storage_path']
                                    }]
                                }]
                            }]
                        });
                        const acordeones = acordeonesRows.map(a => {
                            const plain = a.get ? a.get({ plain: true }) : a;
                            let link = plain.url_link || null;
                            if (plain.documento && plain.documento.archivodoc) {
                                const st = (plain.documento.archivodoc.storage || {});
                                link = (st.storage_path || '') + (plain.documento.archivodoc.file_path || '');
                                if (link && !/^https?:\/\//i.test(link)) link = 'https://cdn.morena.app/' + link.replace(/^\//, '');
                            }
                            return {
                                id_wb_comp_acordeon: plain.id_wb_comp_acordeon,
                                titulo: plain.titulo || (plain.documento ? plain.documento.nombre : ''),
                                texto: plain.texto,
                                url_link: link,
                                link: link
                            };
                        });
                        sub.acordeones = acordeones;
                    }
                }
            }

            componentedata.dataValues.contenedor_acordeon = contenedor;
        }

        // Si es wb_comp_coleccion_fotografica, obtener el tag manualmente
        if (tabla === 'wb_comp_coleccion_fotografica' && componentedata && componentedata[tabla] && componentedata[tabla].length > 0) {
            for (let coleccion of componentedata[tabla]) {
                if (coleccion.fk_id_cat_tag) {
                    const tag = await dbConection.models.cat_tags.findOne({
                        where: { id_cat_tag: coleccion.fk_id_cat_tag },
                        attributes: ['id_cat_tag', 'tag', 'descripcion_tag'],
                        raw: true
                    });
                    if (tag) {
                        coleccion.dataValues.cat_tag = tag;
                        // También asignarlo directamente por si acaso
                        coleccion.cat_tag = tag;
                    }
                }
            }
        }
        // // console.log('📌 Componentedata:', componentedata);

        let tags = new Set();
        let type_content;

        const tiene_tag = {
            wb_comp_galeria_tag,
            wb_comp_acordeon,
            wb_comp_coleccion_fotografica,
            
        };
        const tiene_tag_arr = {
            wb_comp_coleccion_docs
        }

        if (tiene_tag[tabla]) {
            let componentedatatag = await componente.findAll({
                where: {
                    id_wb_pag_componente: id_componente,
                    vigente: true,
                },
                include: [{
                    model: Modelpadre,
                    as: tabla,
                    required: false,
                    where: { vigente: true }
                }],
                
            });
            // // console.log('📌 Componentedatatag:', componentedatatag);

            componentedatatag.forEach(comp => {
                comp.dataValues[tabla].forEach(entry => {
                    tags.add(entry.dataValues.fk_id_cat_tag);
                    type_content = entry.dataValues.fk_id_cat_wb_type_content_tag;
                });
            });

            let tagsArray = Array.from(tags);
            // // console.log('📌 Tags Array:', tagsArray);

            componentedata.tagcontent = await componente.getTagContent(tagsArray, type_content, idapp);
            //// console.log('📌 Tags:', componentedata.tagcontent);
        }
        if (tiene_tag_arr[tabla]) {
            let componentedatatag = await componente.findAll({
                where: {
                    id_wb_pag_componente: id_componente,
                    vigente: true,
                },
                include: [{
                    model: Modelpadre,
                    as: tabla,
                    required: false,
                    where: { vigente: true }
                }]
            });

            componentedatatag.forEach(comp => {
                comp.dataValues[tabla].forEach(entry => {
                    entry.dataValues.fk_id_cat_tag.forEach(tagid => {
                        tags.add(tagid);
                    });
                    type_content = entry.dataValues.fk_id_cat_wb_type_content_tag;
                });
            });

            let tagsArray = Array.from(tags);
            componentedata.tagcontent = await componente.getTagContent(tagsArray, type_content, idapp);
        }

        //console.log(util.inspect(componentedata, { depth: 5, colors: true }));

        return componentedata;
    } catch (e) {
        console.error(e);
        return false;
    }
};

componente.getTagContent = async ( id_tag, type_content, id_sysapp ) => {
    // // console.log('📌 Tags recibidas:', id_tag);
    // // console.log('📌 Tipo de contenido:', type_content);
    // // console.log('📌 ID SysApp:', id_sysapp);

    try {
        let elementos = [];

        if(type_content===1){
            elementos = await documento.findAll({
                where: {
                    fk_id_sysapp: id_sysapp,
                    vigente: true,
                },
                include: {
                    model: cat_tags,
                    where: { id_cat_tag: id_tag },
                    through: {
                        where: { vigente: true },
                        attributes: []
                    }
                },
                // logging: // console.log
            });
        }
        else if(type_content===2){
            elementos = await pagina.findAll({
                where: {
                    fk_id_sysapp: id_sysapp,
                    fk_id_cat_type_pagina:5,
                    vigente: true,
                    // publicada: true 
                },
                include: {
                    model: cat_tags,
                    where: { id_cat_tag: id_tag },
                    through: {
                        where: { vigente: true },
                        attributes: []
                    }
                },
                // logging: // console.log
            });
        } else if(type_content===3){
            const filesModel = require('../models/files');
            elementos = await imagen.findAll({
                where: {
                    fk_id_sysapp: id_sysapp,
                    vigente: true,
                },
                include: [
                    {
                        model: cat_tags,
                        where: { id_cat_tag: { [Op.in]: id_tag } },
                        through: {
                            where: { vigente: true },
                            attributes: []
                        }
                    },
                    {
                        model: filesModel.files,
                        as: 'archivoimg',
                        required: false,
                        include: [{
                            model: require('../models/storage_files'),
                            as: 'storage',
                            required: false,
                            attributes: ['storage_path']
                        }]
                    }
                ],
                //logging: // console.log: trae toda la consulta de cat tags con su relación con wb_imgs y el tipo de tag o sea de tipo imagen.
            });
        }
        return elementos;
    } catch (e) {
        console.error(e);
        return false
    }
};

componente.getSlideContent = async ( id_comp_tabla,tabla ) => {

    const tiene_dependencia = {
        wb_comp_carrousel: 'wb_comp_slides_carrousel',
        wb_comp_linea: 'wb_comp_slides_linea',
        wb_comp_galeria: 'wb_comp_slides_galeria',
        wb_comp_tabs: 'wb_comp_tab_tabs',
    };

    const atributosPorTabla = {
        wb_comp_slides_carrousel: [
            'id_wb_comp_slides_carrousel',
            'titulo',
            'texto', 
            'btn_text',
            'url_link',
            'fk_id_file',
            'type_slide',
            'orden_visible',
            'vigente',
            'f_reg',
            'f_no_vigente'
        ],
        wb_comp_slides_linea: [
            'id_wb_comp_slides_linea',
            'separador',
            'titulo',
            'texto',
            'fk_id_file',
            'orden_visible',
            'vigente',
            'f_reg',
            'f_no_vigente',
            'fk_id_wb_pagina'
        ],
        wb_comp_slides_galeria: [
            'id_wb_comp_slides_galeria',
            'titulo',
            'texto',
            'fk_id_file',
            'orden_visible',
            'vigente',
            'f_reg',
            'f_no_vigente',
            'fk_id_wb_pagina'
        ],
        wb_comp_tab_tabs: [
            'id_wb_comp_tab_tabs',
            'titulo',
            'texto',
            'fk_id_file',
            'orden_visible',
            'vigente',
            'f_reg',
            'f_no_vigente'
        ]
    };

    let idvar='fk_id_'+tabla;
    
    try {
        let elementos = {};

        const tablaSlides = tiene_dependencia[tabla];
        const atributos = atributosPorTabla[tablaSlides];

        if (!atributos) {
            console.error(`❌ No se definieron atributos para la tabla: ${tablaSlides}`);
            return [];
        }

        elementos = await dbConection.models[tiene_dependencia[tabla]].findAll({
            where: {
                [idvar]: id_comp_tabla,
                vigente: true,
            },
            attributes: atributos,
            raw: true,
            //logging: console.log
        });

        /*console.log(`✅ Slide content obtenido para ${tabla}:`, elementos.map(e => ({ 
            id: e.id_wb_comp_slides_carrousel || e.id_wb_comp_slides_linea || e.id_wb_comp_slides_galeria || e.id_wb_comp_tab_tabs,
            separador: e.separador,
            titulo: e.titulo 
        })));*/

        return elementos;
    } catch (e) {
        console.error('❌ Error en getSlideContent:', e);
        return [];
    }
};


module.exports = {
    pagina,
    componente,
    seccion,
    intercambiarOrdenSeccionesAdyacentes,
    columna,
    cat_tags,
    cat_type_tags,
    cat_wb_type_content_tag,
    cat_bimestres,
    cat_type_carrousel,
    rel_wb_tag_pagina,
    documento,
    rel_wb_tag_doc,
    imagen,
    rel_wb_tag_img,
    tipoComponente,
    rel_wb_pag_borrador,

    wb_comp_titulopag, 
    wb_comp_subtitulo, 
    wb_comp_texto, 
    wb_comp_boton, 
    wb_comp_carrousel,
    wb_comp_slides_carrousel, 
    wb_comp_tabs,
    wb_comp_tab_tabs, 
    wb_comp_flip,
    wb_comp_noticias,
    wb_comp_galeria,
    wb_comp_slides_galeria,
    wb_comp_galeria_tag,
    wb_comp_cards_regeneracion,
    wb_comp_direccion,
    wb_comp_redes,
    wb_comp_acordeon,
    wb_comp_cards,
    wb_comp_linea,
    wb_comp_slides_linea,
    wb_comp_lista_tags,
    wb_comp_img,
    wb_comp_personas,
    wb_comp_video,
    wb_comp_coleccion_fotografica,
    wb_comp_tablas,
    wb_categoria_acordeon,
    wb_contenedor_acordeon,
    rel_wb_subcategoria,
}