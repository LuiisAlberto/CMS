const jwt = require('jsonwebtoken');
const {promisify} = require('util');
const {
        pagina,
        seccion,
        columna,
        componente,
        tipoComponente,
        imagen,
        cat_tags,
        rel_wb_tag_pagina,
        wb_comp_cards_regeneracion,
        rel_wb_tag_doc,
        documento,
    } = require('../models/paginasModel');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { Storage } = require("@google-cloud/storage");
const userModel = require("../models/users");
const storage = new Storage({
    projectId: process.env.BUCKET_NAME,
    keyFilename: `certs/${process.env.BUCKET_KEY}`
});
const filesModel = require('../models/files');
const storage_files = require('../models/storage_files');
const util = require('util');
const { paginate, limpiarObjetoSequelize, normalizeConcatenatedMediaUrl } = require('../util/util');
const { carouselEstatalSvgAsDataUri } = require('../util/carouselEstatalSvgTint');
const { hexToRgb } = require('../util/colorAccent');
const { Sequelize, literal, Op } = require('sequelize');
const componentCache = new NodeCache();

const templateComponente = {
    wb_comp_titulopag: path.join(__dirname, '../views/publics/components/wb_comp_titulopag.ejs'),
    wb_comp_subtitulo: path.join(__dirname, '../views/publics/components/wb_comp_subtitulo.ejs'),
    wb_comp_texto: path.join(__dirname, '../views/publics/components/wb_comp_texto.ejs'),
    wb_comp_boton: path.join(__dirname, '../views/publics/components/wb_comp_boton.ejs'),
    wb_comp_carrousel: path.join(__dirname, '../views/publics/components/wb_comp_carrousel.ejs'),
    wb_comp_tabs: path.join(__dirname, '../views/publics/components/wb_comp_tabs.ejs'),
    wb_comp_flip: path.join(__dirname, '../views/publics/components/wb_comp_flip.ejs'),
    wb_comp_noticias: path.join(__dirname, '../views/publics/components/wb_comp_noticias.ejs'),
    wb_comp_galeria: path.join(__dirname, '../views/publics/components/wb_comp_galeria.ejs'),
    wb_comp_galeria_tag: path.join(__dirname, '../views/publics/components/wb_comp_galeria_tag.ejs'),
    wb_comp_direccion: path.join(__dirname, '../views/publics/components/wb_comp_direccion.ejs'),
    wb_comp_acordeon: path.join(__dirname, '../views/publics/components/wb_comp_acordeon.ejs'),
    wb_comp_cards: path.join(__dirname, '../views/publics/components/wb_comp_cards.ejs'),
    wb_comp_linea: path.join(__dirname, '../views/publics/components/wb_comp_linea.ejs'),
    wb_comp_redes: path.join(__dirname, '../views/publics/components/wb_comp_redes.ejs'),
    wb_comp_cards_regeneracion: path.join(__dirname, '../views/publics/components/wb_comp_cards_regeneracion.ejs'),
    wb_comp_lista_tags: path.join(__dirname, '../views/publics/components/wb_comp_lista_tags.ejs'),
    wb_comp_img: path.join(__dirname, '../views/publics/components/wb_comp_img.ejs'),
    wb_comp_personas: path.join(__dirname, '../views/publics/components/wb_comp_personas.ejs'),
    wb_comp_video: path.join(__dirname, '../views/publics/components/wb_comp_video.ejs'),
    wb_comp_coleccion_fotografica: path.join(__dirname, '../views/publics/components/wb_comp_coleccion_fotografica.ejs'),
    wb_comp_tabla: path.join(__dirname, '../views/publics/components/wb_comp_coleccion_fotografica.ejs')
};

// function isIntFile(value) {
//     if (Number.isInteger(value)) {
//         return true;
//     }
//     if (Array.isArray(value)) {
//         return value.every(Number.isInteger);
//     }
//     return false;
// }

function isIntFile(value) {
    const isNumeric = val => Number.isInteger(val) || (typeof val === 'string' && /^\d+$/.test(val));

    if (value == null) return false;
    if (isNumeric(value)) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.length === 0 || value.every(isNumeric);
    }
    // PostgreSQL a veces devuelve arrays como string "{1,2,3}"
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        return true;
    }
    return false;
}

/** Normaliza fk_id_file desde BD: puede ser array de números/strings o string tipo "{1,2,3}" / "[1,2,3]" */
function normalizeFileIds(value) {
    if (value == null) return [];
    if (Number.isInteger(value) || (typeof value === 'string' && /^\d+$/.test(value))) {
        return [parseInt(value, 10)];
    }
    if (Array.isArray(value)) {
        return value.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
    }
    if (typeof value === 'string') {
        if (value.startsWith('[')) {
            try {
                const arr = JSON.parse(value);
                return Array.isArray(arr) ? arr.map(id => parseInt(id, 10)).filter(n => !isNaN(n)) : [];
            } catch (_) { return []; }
        }
        if (value.startsWith('{')) {
            const inner = value.replace(/^\{|\}$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''));
            return inner.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
        }
    }
    return [];
}

function normalizeMediaUrl(url) {
    let out = String(url || '');
    while (out.includes('/cdn/cdn/')) {
        out = out.replace(/\/cdn\/cdn\//g, '/cdn/');
    }
    return out;
}

function normalizeStorageAndFilePath(storagePath, filePath) {
    const defaultStorage = 'https://cdn.morena.app';
    let storage = String(storagePath || defaultStorage).trim();
    let file = String(filePath || '').trim();

    // Normaliza separadores y duplicados evidentes.
    storage = normalizeMediaUrl(storage).replace(/\/+$/, '');
    file = normalizeMediaUrl(file).replace(/^\/+/, '');

    // Evita resultados tipo ".../cdn/cdn/websites/..." al concatenar.
    if (/\/cdn$/i.test(storage) && /^cdn\//i.test(file)) {
        file = file.replace(/^cdn\//i, '');
    }

    // Plantillas concatenan directamente storage_path + file_path.
    return {
        storage_path: storage + '/',
        file_path: file
    };
}

/** Documentos con include `archivodoc` desde BD instancia: si no hay fila en `files`, rellenar desde filesMain (misma lógica que getTagImg). */
async function enrichArchivodocFromFilesMainForDocs(docs) {
    if (!Array.isArray(docs) || !docs.length) return;
    const needIds = [];
    for (const d of docs) {
        const arch = d && d.archivodoc;
        const hasFp = arch && arch.file_path;
        if (!hasFp && d && d.fk_id_file) needIds.push(d.fk_id_file);
    }
    const unique = [...new Set(needIds)].filter((id) => id != null);
    if (!unique.length) return;
    const rows = await filesModel.filesMain.findAll({
        where: { id_file: unique },
        attributes: ['id_file', 'file_path'],
        include: [{
            model: storage_files,
            as: 'storageM',
            required: false,
            attributes: ['storage_path']
        }],
        raw: true,
        nest: true
    });
    const map = {};
    (rows || []).forEach((f) => {
        const st = f.storageM || f.storage_m || {};
        map[f.id_file] = {
            file_path: f.file_path || null,
            storage: { storage_path: st.storage_path || null }
        };
    });
    for (const d of docs) {
        const arch = d && d.archivodoc;
        const hasFp = arch && arch.file_path;
        if (hasFp) continue;
        const built = map[d.fk_id_file];
        if (built && built.file_path) {
            d.archivodoc = built;
        }
    }
}

/** URL pública para miniatura de regeneración (evita concat rotas y alinea con enlace PDF vía cdn.morena.app). */
function regeneracionCardThumbUrl(ic) {
    if (!ic || !ic.file_path) return '';
    const norm = normalizeStorageAndFilePath(ic.storage_path, ic.file_path);
    let url = String(norm.storage_path || '') + String(norm.file_path || '');
    url = normalizeConcatenatedMediaUrl(normalizeMediaUrl(url));
    if (url && /^https?:\/\//i.test(url)) return url;
    return normalizeConcatenatedMediaUrl('https://cdn.morena.app/' + String(ic.file_path).replace(/^\/+/, ''));
}

// AJUSTE 2: Función `replacefile` ahora usa `parseInt`
async function replacefile(obj, tabla, includeTags) {
    let stack = [{ parent: null, current: obj }];
    
    while (stack.length > 0) {
        let { parent, current } = stack.pop();
        for (let key in current) {
            if (/^(_|options|type|uniqno|remove|get|is|run|raw|add|create|has|set|count)/.test(key)) {
                delete current[key];
                continue;
            }

            if ((key === 'fk_id_file' || key === 'fk_id_file_izq') && isIntFile(current[key])) {
                const value = current[key];
                const fileIds = normalizeFileIds(value);
                const arr_files = [];

                for (const fileId of fileIds) {
                    let file_mod = await filesModel.files.findOne({
                        where: { id_file: fileId },
                        include: [{
                            model: storage_files,
                            as: 'storage',
                            required: false
                        }]
                    });

                    // Fallback: algunas instancias guardan archivos en filesMain
                    if (!file_mod || !file_mod.dataValues) {
                        const file_main = await filesModel.filesMain.findOne({
                            where: { id_file: fileId },
                            include: [{
                                model: storage_files,
                                as: 'storageM',
                                required: false
                            }]
                        });

                        if (file_main && file_main.dataValues) {
                            const fm = file_main.dataValues;
                            const stM = fm.storageM ? (fm.storageM.dataValues || fm.storageM) : null;
                            const storage_path_m = stM && stM.storage_path ? stM.storage_path : null;
                            const storage_name_m = stM && stM.storage_name ? stM.storage_name : '';
                            const fp_m = fm.file_path;
                            if (fp_m != null) {
                                const normalizedMedia = normalizeStorageAndFilePath(
                                    storage_path_m || 'https://cdn.morena.app',
                                    fp_m
                                );
                                arr_files.push({
                                    id_file: fm.id_file,
                                    file_path: normalizedMedia.file_path,
                                    storage_name: storage_name_m,
                                    storage_path: normalizedMedia.storage_path
                                });
                            }
                        }
                        continue;
                    }

                    let storage_path = null;
                    let storage_name = '';
                    if (file_mod.dataValues.storage && file_mod.dataValues.storage.dataValues) {
                        storage_path = file_mod.dataValues.storage.dataValues.storage_path;
                        storage_name = file_mod.dataValues.storage.dataValues.storage_name || '';
                    }
                    if (storage_path == null && file_mod.dataValues.fk_id_storage != null) {
                        const stor = await storage_files.findByPk(file_mod.dataValues.fk_id_storage, { raw: true });
                        if (stor) {
                            storage_path = stor.storage_path;
                            storage_name = stor.storage_name || '';
                        }
                    }
                    const fp = file_mod.dataValues.file_path;
                    if (fp != null) {
                        const storageFinal = (storage_path != null && String(storage_path).trim())
                            ? storage_path
                            : 'https://cdn.morena.app';
                        const normalizedMedia = normalizeStorageAndFilePath(storageFinal, fp);
                        arr_files.push({
                            id_file: file_mod.dataValues.id_file,
                            file_path: normalizedMedia.file_path,
                            storage_name,
                            storage_path: normalizedMedia.storage_path,
                        });
                    }
                }

                current[key] = arr_files;

            } else if (typeof current[key] === 'object' && current[key] !== null) {
                stack.push({ parent: { key: key, object: current }, current: current[key] });
            }
        }
    }
    
    return obj;
}

async function renderTemplateCache(tabla, id, idapp) {
    const result = await renderComponente(tabla, id, idapp);

    if (!result || typeof result.rend !== 'string') {
        // Nada que renderizar, devolvemos cadena vacía
        return '';
    }

    const { rend } = result;
    return rend;
}


async function renderComponente(tabla, id,idapp) {
    try {
        const renderComponente = templateComponente[tabla];

        if (!renderComponente) {
            throw new Error(`Componente "${tabla}" no declarado en los templates`);
        }

        let objcomp = await componente.getComponente(tabla, id, idapp);
        if (objcomp && idapp != null) {
            objcomp.id_sysapp = idapp;
        }

        if(tabla === 'wb_comp_cards'){
            // console.log(objcomp.wb_comp_cards);
        }
        
        let slidecontent = [];
        let objPagEntrada = [];
        let objDocsRegeneracion = [];
        let additionalProps;
        let type_carrousel = null;
        let carouselEstatalBgUri = null;
        let carouselEstatalOverlayRgba = null;

        switch (tabla) {
            case 'wb_comp_carrousel': {
                // Obtenemos el registro del componente de carrusel
                const carrouselRow = objcomp?.dataValues?.[tabla]?.[0]?.dataValues;

                if (carrouselRow) {
                    const id_comp_tabla = carrouselRow.id_wb_comp_carrousel;
                    additionalProps = carrouselRow.fk_id_cat_type_carrousel;
                    type_carrousel = additionalProps; // 🔹 ahora sí se guarda
                    const _ca = carrouselRow.color_acento && String(carrouselRow.color_acento).trim();
                    if (_ca && /^#[0-9A-Fa-f]{6}$/.test(_ca)) {
                        const _hex = _ca.startsWith('#') ? _ca : `#${_ca}`;
                        const { r, g, b } = hexToRgb(_hex);
                        carouselEstatalOverlayRgba = `rgba(${r}, ${g}, ${b}, 0.45)`;
                        try {
                            carouselEstatalBgUri = carouselEstatalSvgAsDataUri(_ca);
                        } catch (e) {
                            console.warn('carouselEstatalSvgAsDataUri:', e.message);
                        }
                    }

                    if (id_comp_tabla) {
                        // Slides crudos desde la BD
                        slidecontent = await componente.getSlideContent(id_comp_tabla, 'wb_comp_carrousel');

                        // Procesar cada slide individualmente con replacefile
                        if (slidecontent && slidecontent.length > 0) {
                            for (let i = 0; i < slidecontent.length; i++) {
                                slidecontent[i] = await replacefile(slidecontent[i], tabla);
                            }
                        }
                    }
                }
                break;
            }
            case 'wb_comp_tabs': {
                const id_comp_tabla = objcomp?.dataValues?.[tabla]?.[0]?.dataValues?.id_wb_comp_tabs;
                if (id_comp_tabla) {
                    slidecontent = await componente.getSlideContent(id_comp_tabla, 'wb_comp_tabs');
                }
                break;
            }
            case 'wb_comp_galeria': {
                const id_comp_tabla = objcomp?.dataValues?.[tabla]?.[0]?.dataValues?.id_wb_comp_galeria;

                if (id_comp_tabla) {
                    slidecontent = await componente.getSlideContent(id_comp_tabla, 'wb_comp_galeria');
                    if (slidecontent && slidecontent.length > 0) {
                        for (let i = 0; i < slidecontent.length; i++) {
                            slidecontent[i] = await replacefile(slidecontent[i], tabla);
                        }
                    }
                }
                break;
            }
            case 'wb_comp_linea': {
                const id_comp_tabla = objcomp?.dataValues?.[tabla]?.[0]?.dataValues?.id_wb_comp_linea;
                if (id_comp_tabla) {
                    slidecontent = await componente.getSlideContent(id_comp_tabla, 'wb_comp_linea');
                    if (slidecontent && slidecontent.length > 0) {
                        for (let i = 0; i < slidecontent.length; i++) {
                            slidecontent[i] = await replacefile(slidecontent[i], tabla);
                        }
                    }
                }
                break;
            }
            // case 'wb_comp_acordion': {
            //     // Organizar acordeones por contenedor -> categoría -> subcategoría
            //     const acordeones = objcomp?.dataValues?.[tabla] || [];
            //     const contenedoresMap = new Map();

            //     acordeones.forEach(acordeon => {
            //         const acordeonData = acordeon.dataValues;
            //         const subcategoria = acordeonData.subcategoria?.dataValues;
            //         const categoria = subcategoria?.categoria?.dataValues;
            //         const contenedor = categoria?.contenedor?.dataValues;

            //         if (!contenedor || !categoria || !subcategoria) return;

            //         const contenedorId = contenedor.id_wb_contenedor_acordeon;
            //         const categoriaId = categoria.id_wb_categoria_acordeon;
            //         const subcategoriaId = subcategoria.id_rel_wb_subcategoria;

            //         // Inicializar contenedor si no existe
            //         if (!contenedoresMap.has(contenedorId)) {
            //             contenedoresMap.set(contenedorId, {
            //                 id: contenedorId,
            //                 titulo: contenedor.titulo,
            //                 descripcion: contenedor.descripcion,
            //                 categorias: new Map()
            //             });
            //         }

            //         const cont = contenedoresMap.get(contenedorId);

            //         // Inicializar categoría si no existe
            //         if (!cont.categorias.has(categoriaId)) {
            //             cont.categorias.set(categoriaId, {
            //                 id: categoriaId,
            //                 descripcion: categoria.descripcion,
            //                 subcategorias: new Map()
            //             });
            //         }

            //         const cat = cont.categorias.get(categoriaId);

            //         // Inicializar subcategoría si no existe
            //         if (!cat.subcategorias.has(subcategoriaId)) {
            //             cat.subcategorias.set(subcategoriaId, {
            //                 id: subcategoriaId,
            //                 titulo: subcategoria.titulo,
            //                 acordeones: []
            //             });
            //         }

            //         const subcat = cat.subcategorias.get(subcategoriaId);

            //         // Construir link desde tagcontent si existe
            //         let link = '#';
            //         if (objcomp.tagcontent && Array.isArray(objcomp.tagcontent)) {
            //             const tagItem = objcomp.tagcontent.find(t => 
            //                 t.id_wb_pagina && acordeonData.fk_id_cat_tag
            //             );
            //             if (tagItem && tagItem.url_safe) {
            //                 link = `/detalle?id=${tagItem.id_wb_pagina}&url=${tagItem.url_safe}`;
            //             }
            //         }

            //         // Agregar acordeón
            //         subcat.acordeones.push({
            //             id: acordeonData.id_wb_comp_acordeon,
            //             titulo: acordeonData.titulo,
            //             texto: acordeonData.texto,
            //             span_color: acordeonData.span_color,
            //             link: link
            //         });
            //     });

            //     // Convertir Maps a Arrays para EJS
            //     objcomp.contenedoresAcordeon = Array.from(contenedoresMap.values()).map(cont => ({
            //         ...cont,
            //         categorias: Array.from(cont.categorias.values()).map(cat => ({
            //             ...cat,
            //             subcategorias: Array.from(cat.subcategorias.values())
            //         }))
            //     }));
            //     break;
            // }
            case 'wb_comp_noticias': {
                const compRows = objcomp?.dataValues?.[tabla] || objcomp?.[tabla] || [];
                const compRowRaw = Array.isArray(compRows) && compRows.length > 0 ? compRows[0] : null;
                const compRow = compRowRaw ? (compRowRaw.dataValues || compRowRaw) : null;
                if (!compRow) {
                    objcomp.objPagEntrada = [];
                    break;
                }

                let tag_comp = compRow.fk_id_cat_tag;
                if (!tag_comp) {
                    objcomp.objPagEntrada = [];
                    break;
                }
                //// console.log(tag_comp)

                let relTagPag = await rel_wb_tag_pagina.findAll({
                    where: { fk_id_cat_tag: tag_comp, vigente: true },
                    attributes: ['fk_id_wb_pagina', 'fk_id_cat_tag']
                });

                if (!relTagPag) {
                    res.status(500).json({ success: false, error: 1, message: 'Error, la entrada no existe.' });
                    return;
                }

                let idsPaginas = relTagPag.map(tag => tag.fk_id_wb_pagina);
                //// console.log(idsPaginas)

                if (!idsPaginas.length) {
                    objcomp.objPagEntrada = [];
                    break;
                }

                // Últimas noticias: por fecha de publicación; si falta, por f_reg; desempate por id.
                // Solo entradas publicadas (tipo 5), para no mezclar borradores ni otros tipos.
                let pagEntrada = await pagina.findAll({
                    where: {
                        id_wb_pagina: idsPaginas,
                        fk_id_sysapp: idapp,
                        vigente: true,
                        fk_id_cat_type_pagina: 5,
                    },
                    attributes: [
                        'id_wb_pagina',
                        'nombre_pagina',
                        'contenido_alt',
                        'fk_id_file',
                        'f_reg',
                        'url_safe',
                        'fk_id_sysapp',
                        'f_publicacion',
                    ],
                    include: [{
                        model: filesModel.files,
                        as: 'archivo',
                        attributes: ['file_path'],
                        include: [{
                            model: storage_files,
                            as: 'storage',
                            required: false,
                            attributes: ['storage_path']
                        }]
                    }],
                    limit: 10,
                    order: [
                        [Sequelize.fn('COALESCE', Sequelize.col('f_publicacion'), Sequelize.col('f_reg')), 'DESC'],
                        ['id_wb_pagina', 'DESC'],
                    ],
                });

                if (!pagEntrada) { //REVISAR componente cuando no hay entradas
                    res.status(500).json({ success: false, error: 1, message: 'Error, la entrada no existe.' });
                    return;
                }

                const pageFileIds = [...new Set((pagEntrada || []).map(p => p.fk_id_file).filter(Boolean))];
                const filesMainMap = {};
                if (pageFileIds.length > 0) {
                    const filesMainRows = await filesModel.filesMain.findAll({
                        where: { id_file: pageFileIds },
                        attributes: ['id_file', 'file_path'],
                        include: [{
                            model: storage_files,
                            as: 'storageM',
                            required: false,
                            attributes: ['storage_path']
                        }],
                        raw: true,
                        nest: true
                    });
                    filesMainRows.forEach(fm => {
                        filesMainMap[fm.id_file] = {
                            file_path: fm.file_path || null,
                            storage_path: (fm.storageM && fm.storageM.storage_path) ? fm.storageM.storage_path : null
                        };
                    });
                }

                objcomp.objPagEntrada = pagEntrada?.map(pagina => {
                    const filePath = pagina.archivo ? pagina.archivo.file_path : null;
                    const storagePath = (pagina.archivo && pagina.archivo.storage && pagina.archivo.storage.storage_path)
                        ? pagina.archivo.storage.storage_path
                        : null;
                    const fm = filesMainMap[pagina.fk_id_file] || null;
                    const resolvedFilePath = filePath || (fm ? fm.file_path : null);
                    const resolvedStoragePath = storagePath || (fm ? fm.storage_path : null);
                    const normalizedMedia = resolvedFilePath
                        ? normalizeStorageAndFilePath(resolvedStoragePath || 'https://cdn.morena.app', resolvedFilePath)
                        : null;
                    const imageSrc = normalizedMedia
                        ? normalizeMediaUrl((normalizedMedia.storage_path || '') + (normalizedMedia.file_path || ''))
                        : '';
                    return ({
                    pag_tag_cy: jwt.sign(
                        {
                            id_wb_pagina: pagina.id_wb_pagina,
                            id_tag: tag_comp,
                            idapp: idapp,
                            date_comp: new Date()
                        },
                        process.env.SECRET
                    ),
                    nombre_pagina: pagina.nombre_pagina,
                    contenido_alt: pagina.contenido_alt,
                    file_path: normalizedMedia ? normalizedMedia.file_path : resolvedFilePath,
                    image_src: imageSrc,
                    f_reg: pagina.f_publicacion || pagina.f_reg,
                    f_publicacion: pagina.f_publicacion,
                    url_safe: pagina.url_safe,
                    fk_id_sysapp: pagina.fk_id_sysapp,
                    detailUrl: `entradas/${String((pagina.url_safe || pagina.id_wb_pagina)).trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-').toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'entrada'}.html`,
                    allEntriesUrl: 'entradas.html'
                })});
                //// console.log(objcomp.objPagEntrada);
                break;
            }
            case 'wb_comp_cards_regeneracion': {
                const anioComponente = objcomp.wb_comp_cards_regeneracion[0]?.dataValues?.anio_seleccionado;
                //console.log("Año del componente de regeneración:", anioComponente);

                if (anioComponente) {
                    try {
                        // PRIMERO: Obtener las relaciones de regeneración (documentos PDF) - sin filtrar por instancia aquí
                        const relacionesRegeneracion = await rel_wb_tag_doc.findAll({
                            where: {
                                fk_id_cat_tag: 13, // Tag regeneración
                                anio: anioComponente,
                                vigente: true
                            },
                            attributes: ['id_rel_wb_tag_doc', 'fk_id_wb_doc', 'fk_id_cat_bimestre', 'f_reg'],
                            order: [['f_reg', 'DESC']],
                            limit: 3,
                            raw: true
                        });

                        if (relacionesRegeneracion.length === 0) {
                            objcomp.regeneracionesData = [];
                            objcomp.regeneracionListToken = jwt.sign({ idapp, date_comp: new Date() }, process.env.SECRET);
                            break;
                        }

                        const idsDocumentos = relacionesRegeneracion.map(rel => rel.fk_id_wb_doc);
                        const bimestres = relacionesRegeneracion.map(rel => rel.fk_id_cat_bimestre);

                        // SEGUNDO: Obtener los documentos (PDFs) de esta instancia con sus archivos
                        const documentos = await documento.findAll({
                            where: {
                                id_wb_doc: idsDocumentos,
                                fk_id_sysapp: idapp,
                                vigente: true
                            },
                            include: [{
                                model: filesModel.files,
                                as: 'archivodoc',
                                include: [{
                                    model: storage_files,
                                    as: 'storage'
                                }]
                            }],
                            raw: true,
                            nest: true
                        });
                        await enrichArchivodocFromFilesMainForDocs(documentos);

                        // TERCERO: Obtener las imágenes de card (incluir f_reg para emparejar por orden de creación)
                        const relacionesImagenes = await rel_wb_tag_doc.findAll({
                            where: {
                                fk_id_cat_tag: 14, // Tag imagen_regeneracion
                                anio: anioComponente,
                                fk_id_cat_bimestre: bimestres,
                                vigente: true
                            },
                            attributes: ['fk_id_wb_doc', 'fk_id_cat_bimestre', 'f_reg'],
                            order: [['f_reg', 'ASC']],
                            raw: true
                        });

                        // CUARTO: Obtener los documentos de imagen de esta instancia
                        const idsImagenes = relacionesImagenes.map(rel => rel.fk_id_wb_doc);
                        const imagenesDocs = await documento.findAll({
                            where: {
                                id_wb_doc: idsImagenes,
                                fk_id_sysapp: idapp,
                                vigente: true
                            },
                            include: [{
                                model: filesModel.files,
                                as: 'archivodoc',
                                include: [{
                                    model: storage_files,
                                    as: 'storage'
                                }]
                            }],
                            raw: true,
                            nest: true
                        });
                        await enrichArchivodocFromFilesMainForDocs(imagenesDocs);

                        // COMBINAR: emparejar cada PDF con su imagen por proximidad de f_reg; cada imagen solo se usa una vez
                        const imagenesUsadas = new Set(); // id_wb_doc de imágenes ya asignadas
                        const regeneracionesCompletas = relacionesRegeneracion
                            .map(rel => {
                                const doc = documentos.find(d => d.id_wb_doc === rel.fk_id_wb_doc);
                                if (!doc) return null; // doc de otra instancia
                                const tPdf = new Date(rel.f_reg).getTime();
                                const candidatas = relacionesImagenes
                                    .filter(img => img.fk_id_cat_bimestre === rel.fk_id_cat_bimestre && !imagenesUsadas.has(img.fk_id_wb_doc))
                                    .map(img => ({ ...img, t: new Date(img.f_reg).getTime() }));
                                const imgRel = candidatas
                                    .filter(c => c.t >= tPdf)
                                    .sort((a, b) => a.t - b.t)[0]
                                    || candidatas.sort((a, b) => b.t - a.t)[0]; // fallback: imagen más reciente antes del PDF
                                if (imgRel) imagenesUsadas.add(imgRel.fk_id_wb_doc);
                                const imgDoc = imgRel ? imagenesDocs.find(imgD => imgD.id_wb_doc === imgRel.fk_id_wb_doc) : null;

                                return {
                                    // Datos del documento PDF
                                    nombre_doc: doc?.nombre,
                                    file_path: doc?.archivodoc?.file_path,
                                    storage_path: doc?.archivodoc?.storage?.storage_path,

                                    // Datos de la imagen de la card (thumb_url: URL estable para <img>, mismo criterio que PDFs)
                                    imagen_card: imgDoc?.archivodoc && imgDoc.archivodoc.file_path ? {
                                        file_path: imgDoc.archivodoc.file_path,
                                        storage_path: imgDoc.archivodoc.storage?.storage_path,
                                        thumb_url: regeneracionCardThumbUrl({
                                            file_path: imgDoc.archivodoc.file_path,
                                            storage_path: imgDoc.archivodoc.storage?.storage_path
                                        })
                                    } : null,

                                    // Información adicional
                                    bimestre: rel.fk_id_cat_bimestre,
                                    f_reg: rel.f_reg
                                };
                            })
                            .filter(Boolean);

                        objcomp.objDocsRegeneracion = regeneracionesCompletas;
                        objcomp.regeneracionListToken = jwt.sign({ idapp, date_comp: new Date() }, process.env.SECRET);
                        objcomp.regeneracionToken = jwt.sign(
                            {
                                anio: anioComponente,
                                date_comp: new Date()
                            },
                            process.env.SECRET
                        );

                    } catch (error) {
                        console.error("Error en consulta de regeneraciones:", error);
                        objcomp.regeneracionesData = [];
                    }
                    if (!objcomp.regeneracionListToken) {
                        objcomp.regeneracionListToken = jwt.sign({ idapp, date_comp: new Date() }, process.env.SECRET);
                    }
                } else {
                    console.log("No se encontró año configurado en el componente de regeneración");
                    objcomp.regeneracionesData = [];
                    objcomp.regeneracionListToken = jwt.sign({ idapp, date_comp: new Date() }, process.env.SECRET);
                }
                break;
            }
            case 'wb_comp_coleccion_fotografica': {
                const compRows = objcomp?.dataValues?.[tabla] || objcomp?.[tabla] || [];
                const tagIds = (Array.isArray(compRows) ? compRows : [])
                    .map((r) => {
                        const row = r?.dataValues || r;
                        return row?.fk_id_cat_tag ? parseInt(row.fk_id_cat_tag, 10) : null;
                    })
                    .filter((v) => Number.isInteger(v));

                if (tagIds.length === 0) {
                    objcomp.tagcontent = [];
                    break;
                }

                const imgs = await imagen.findAll({
                    where: {
                        fk_id_sysapp: idapp,
                        vigente: true
                    },
                    include: [
                        {
                            model: cat_tags,
                            where: { id_cat_tag: { [Op.in]: tagIds } },
                            through: { where: { vigente: true } },
                            required: true
                        },
                        {
                            model: filesModel.files,
                            as: 'archivoimg',
                            required: false,
                            attributes: ['file_path'],
                            include: [
                                {
                                    model: storage_files,
                                    as: 'storage',
                                    required: false,
                                    attributes: ['storage_path']
                                }
                            ]
                        }
                    ],
                    order: [['id_wb_img', 'DESC']],
                    limit: 1000
                });

                const plainImgs = (imgs || []).map((i) => (i.get ? i.get({ plain: true }) : i));
                const idsFile = [...new Set(plainImgs.map((i) => i.fk_id_file).filter(Boolean))];
                let fileMapFromMain = {};
                if (idsFile.length > 0) {
                    const filesFromMain = await filesModel.filesMain.findAll({
                        where: { id_file: idsFile },
                        attributes: ['id_file', 'file_path'],
                        include: [{
                            model: storage_files,
                            as: 'storageM',
                            required: false,
                            attributes: ['storage_path']
                        }],
                        raw: true,
                        nest: true
                    });
                    filesFromMain.forEach(f => {
                        const st = f.storageM || {};
                        fileMapFromMain[f.id_file] = {
                            file_path: f.file_path || null,
                            storage_path: st.storage_path || null
                        };
                    });
                }

                objcomp.tagcontent = plainImgs.map((img) => {
                    if (img.archivoimg && img.archivoimg.file_path) return img;
                    const fm = img.fk_id_file ? fileMapFromMain[img.fk_id_file] : null;
                    if (!fm || !fm.file_path) return img;
                    return {
                        ...img,
                        archivoimg: {
                            file_path: fm.file_path,
                            storage: { storage_path: fm.storage_path }
                        }
                    };
                });
                break;
            }

            default: {
                break;
            }
        }

        // console.log(util.inspect(objcomp, { depth: 5, colors: true }));
        objcomp.slidecontent = slidecontent;
        let baseobj = objcomp || {};
        objcomp = await replacefile(objcomp, tabla);
        //console.log('🔍 DESPUÉS de replacefile - slidecontent:');
        /*if (objcomp.slidecontent) {
            objcomp.slidecontent.forEach((slide, index) => {
                console.log(`Slide ${index}:`, {
                    titulo: slide.titulo,
                    fk_id_file: slide.fk_id_file,
                    tiene_fk_id_file: Array.isArray(slide.fk_id_file),
                    cantidad_archivos: slide.fk_id_file ? slide.fk_id_file.length : 0,
                    archivos: slide.fk_id_file ? slide.fk_id_file.map(f => ({
                        storage_path: f.storage_path,
                        file_path: f.file_path,
                        full_url: f.storage_path + f.file_path
                    })) : []
                });
            });
        } else {
            console.log('❌ No hay slidecontent después de replacefile');
        }*/

        slidecontent = objcomp.slidecontent;
        const tagcontent = objcomp.tagcontent;

        const template = fs.readFileSync(renderComponente, 'utf8');
        const rend = ejs.render(template, { 
            objcomp,
            slidecontent,
            type_carrousel,      // 🔹 NUEVO
            idComp: id,          // 🔹 NUEVO (para IDs únicos en el carrusel)
            additionalProps,
            carouselEstatalBgUri,
            carouselEstatalOverlayRgba,
            tagcontent,
            objPagEntrada: objcomp.objPagEntrada,
            objDocsRegeneracion: objcomp.objDocsRegeneracion
        });
        
        return {
            rend,
            baseobj,
        };
    } catch (e) {
        console.error('ERROR EN COMP:'+id)
        console.error(e.message)
    }
}
async function getComponentes(req,res){
    let urluri=req.get('host');
    let data_comp=req.body.data_comp;
    let idapp=req.body.idp;

    let arr_uri= urluri.split('/');
    let base = arr_uri[0];
    // let app = arr_uri[1] ? arr_uri[1] : '';
    // let pagina_uri = arr_uri[2] ? arr_uri[2] : '/';
    // let parametro = arr_uri[3] ? arr_uri[3] : '';
    // urluri=base+'/'+app

    try {
        let key='';
        if(global.catalogos.cat_apps_activas) {
            Object.values(global.catalogos.cat_apps_activas).forEach(app =>{
                if(parseInt(idapp)===parseInt(app.id_sysapp)) key=app.key_sysapp;
            });
            if(process.env.APP_BASE_URL!==base) throw new Error ('ALERTA petición de app no permitida');
        } else  {
            throw new Error ('No se cargó el catálogo de apps');
        }

        // Fallback: si la instancia no está en el catálogo global (creada después del arranque),
        // buscarla directamente en la BD principal para obtener key_sysapp.
        if (!key) {
            const AppsModel = require('../models/AppsModel');
            const appDb = await AppsModel.findOne({
                where: { id_sysapp: parseInt(idapp, 10), vigente: true },
                raw: true
            });
            if (appDb && appDb.key_sysapp) {
                key = appDb.key_sysapp;
            }
        }

        if (!key) {
            throw new Error('No se encontró key_sysapp para la instancia solicitada');
        }

        const decoded = await promisify(jwt.verify)(data_comp, key);
        const decodedCompTable = decoded.tabla;
        const decoded_id_comp = decoded.id_componente;
        // // console.log(decodedCompTable);
        // // console.log(decoded_id_comp);
        
        const type_componente = await tipoComponente.findOne({
            where: {table_componente: decodedCompTable},
        });
        let type_componente_name = type_componente.type_componente;

        if(!decoded) throw new Error ('Error en cifrado de componente');

        const date_comp=new Date(decoded.date_comp);
        const date_now=new Date();
        let comparedates=date_comp.getUTCFullYear() === date_now.getUTCFullYear() &&
            date_comp.getMonth() === date_now.getMonth() &&
            date_comp.getDate() === date_now.getDate();

        if(!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        const htmlcomp = await renderTemplateCache(decoded.tabla,decoded.id_componente,idapp)

        res.json({ 
            success: true, 
            msg: 'Componente obtenido',
            templateComponenteHtml: htmlcomp, 
            comp: decodedCompTable,
            idcomp: decoded_id_comp,
            nameComp: type_componente_name,
            tipocomp: type_componente.id_cat_wb_componente
        });
    } catch (e) {
        // console.log(e.message);
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Petición no permitida');
    }
}
async function getComponenteObj(req,res){

    let urluri=req.get('host');
    let data_comp=req.body.data_comp;
    let idapp=req.body.idp;

    let arr_uri= urluri.split('/');
    let base = arr_uri[0];

    try {
        let key='';
        if(global.catalogos.cat_apps_activas) {
            Object.values(global.catalogos.cat_apps_activas).forEach(app =>{
                if(parseInt(idapp)===parseInt(app.id_sysapp)) key=app.key_sysapp;
            });
            if(process.env.APP_BASE_URL!==base) throw new Error ('ALERTA petición de app no permitida');
        } else  {
            throw new Error ('No se cargó el catálogo de apps');
        }

        // Si no se encontró la app en el catálogo global (por ejemplo, instancia creada después del arranque),
        // buscarla directamente en la BD principal para obtener key_sysapp.
        if (!key) {
            const AppsModel = require('../models/AppsModel');
            const appDb = await AppsModel.findOne({
                where: { id_sysapp: parseInt(idapp, 10), vigente: true },
                raw: true
            });
            if (appDb && appDb.key_sysapp) {
                key = appDb.key_sysapp;
            }
        }

        if (!key) {
            throw new Error('No se encontró key_sysapp para la instancia solicitada');
        }

        const decoded = await promisify(jwt.verify)(data_comp, key);

        if(!decoded) throw new Error ('Error en cifrado de componente');
        const date_comp=new Date(decoded.date_comp);
        const date_now=new Date();

        let comparedates=date_comp.getUTCFullYear() === date_now.getUTCFullYear() &&
            date_comp.getMonth() === date_now.getMonth() &&
            date_comp.getDate() === date_now.getDate();

        if(!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        // 👇 YA NO DESTRUCTURAMOS DIRECTO
        const result = await renderComponente(decoded.tabla, decoded.id_componente, idapp);
        const baseobj = result ? result.baseobj : null;

        if (!baseobj) {
            return res.status(404).json({
                success: false,
                error: 1,
                msg: "No se encontró el componente."
            });
        }

        const datosLimpios = limpiarObjetoSequelize(baseobj);

        return res.json({
            success: true,
            msg: 'Componente obtenido',
            id_comp: decoded.id_componente,
            objc: datosLimpios
        });

    } catch (e) {
        console.log(e.message);
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Petición no permitida');
    }
}

async function getTagImg(req,res){
    try{
        let { tag, page, search, id_sysapp } = req.body;
        const tagId = (tag != null && tag !== '' && !isNaN(parseInt(tag, 10))) ? parseInt(tag, 10) : null;
        const idappNum = (id_sysapp != null && id_sysapp !== '' && String(id_sysapp) !== 'undefined' && !isNaN(parseInt(id_sysapp, 10)))
            ? parseInt(id_sysapp, 10) : null;

        let pageSize = 6;
        let currentPage = parseInt(page, 10) || 1;
        let offset = (currentPage - 1) * pageSize;
        let whereCondition = { vigente: true };

        if (idappNum != null) {
            whereCondition.fk_id_sysapp = idappNum;
        }

        if (search && String(search).trim()) {
            whereCondition.nombre = { [Sequelize.Op.iLike]: `%${search}%` };
        }

        if (tagId == null) {
            return res.status(200).json({
                success: true,
                error: 0,
                message: 'Datos obtenidos correctamente',
                totalPages: 0,
                currentPage: currentPage,
                totalImages: 0,
                imagenes: []
            });
        }

        const tagWhere = { id_cat_tag: tagId };
        // Obtener imágenes por tag (archivoimg puede venir de tabla "files" o de "filesMain" según el módulo)
        const getDataTagImg = await imagen.findAll({
            where: whereCondition,
            include: [
                {
                    model: cat_tags,
                    where: tagWhere,
                    through: { where: { vigente: true } },
                    required: true
                },
                {
                    model: filesModel.files,
                    as: "archivoimg",
                    required: false,
                    attributes: ["file_path"],
                    include: [
                        {
                            model: storage_files,
                            as: "storage",
                            required: false,
                            attributes: ["storage_path"]
                        }
                    ]
                },
            ],
            limit: pageSize,
            offset: offset,
            order: [['id_wb_img', 'DESC']]
        });

        // Si el módulo de imágenes guarda en filesMain, traer rutas desde ahí cuando archivoimg venga vacío
        const idsFile = [...new Set(getDataTagImg.map(i => i.fk_id_file).filter(Boolean))];
        let fileMapFromMain = {};
        if (idsFile.length > 0) {
            const filesFromMain = await filesModel.filesMain.findAll({
                where: { id_file: idsFile },
                attributes: ['id_file', 'file_path'],
                include: [{
                    model: storage_files,
                    as: 'storageM',
                    required: false,
                    attributes: ['storage_path']
                }],
                raw: true,
                nest: true
            });
            filesFromMain.forEach(f => {
                const st = f.storageM || f.storage_m || {};
                const storagePath = (st && st.storage_path) ? st.storage_path : '';
                fileMapFromMain[f.id_file] = { file_path: f.file_path, storage_path: storagePath };
            });
        }

        const totalImages = await imagen.count({
            where: whereCondition,
            include: [
                {
                    model: cat_tags,
                    where: { id_cat_tag: tagId },
                    through: { where: { vigente: true } },
                    required: true
                }
            ]
        });

        let totalPages = Math.ceil(totalImages / pageSize);

        const baseCdn = 'https://cdn.morena.app/';
        const formattedImages = getDataTagImg.map(img => {
            let file_path = null;
            let storage_path = '';
            if (img.archivoimg && img.archivoimg.file_path) {
                file_path = img.archivoimg.file_path;
                storage_path = (img.archivoimg.storage && img.archivoimg.storage.storage_path) ? img.archivoimg.storage.storage_path : '';
            } else if (img.fk_id_file && fileMapFromMain[img.fk_id_file]) {
                file_path = fileMapFromMain[img.fk_id_file].file_path;
                storage_path = fileMapFromMain[img.fk_id_file].storage_path || '';
            }
            let src = '';
            if (file_path) {
                // Usar CDN público para evitar problemas CORS al abrir estáticos localmente.
                src = baseCdn + file_path.replace(/^\//, '');
            }
            return {
                id_wb_img: img.id_wb_img,
                nombre: img.nombre,
                contenido_alt: img.contenido_alt,
                file_path: file_path,
                storage_path: storage_path || null,
                src: src,
                tab: img.cat_tags?.length > 0
                    ? img.cat_tags[0].tag.replace(/\s+/g, '-').toLowerCase()
                    : null
            };
        });

        // // console.log("✅ Imágenes enviadas:", JSON.stringify(formattedImages, null, 2));
        res.status(200).json({
            success: true,
            error: 0,
            message: "Datos obtenidos correctamente",
            totalPages: totalPages,
            currentPage: currentPage,
            totalImages: totalImages,
            imagenes: formattedImages
        });

    } catch (e) {
        console.error('[getTagImg]', e);
        res.status(500).json({
            success: false,
            error: 1,
            message: 'Error al obtener imágenes.',
            totalPages: 0,
            currentPage: 1,
            totalImages: 0,
            imagenes: []
        });
    }
}

module.exports = {
    getComponentes,
    getComponenteObj,
    getTagImg,
    renderComponente
};
