const paginasModel = require('../models/paginasModel');
const filesModel = require('../models/files');
const {promisify} = require("util");
const jwt = require("jsonwebtoken");
const utilFun = require("../util/util");
const menuModel = require("../models/menuModel");
const sysappModel = require("../models/AppsModel");
const multer = require('multer');
const { Storage } = require('@google-cloud/storage'); 
const path = require('path');
const multiparty = require('multiparty');
const fs = require('fs');
const { Op,Sequelize, literal } = require('sequelize');
const { menu, menuLinks } = require('../models/menuModel.js');
const dbConection = require('../config/postgressdb');
const staticGenerator = require('../util/staticGenerator');

const storage = new Storage({
    projectId: process.env.PUBLIC_BUCKET_NAME,
    keyFilename: `certs/${process.env.PUBLIC_BUCKET_KEY}`
});
const storage_priv = new Storage({
    projectId: process.env.BUCKET_NAME,
    keyFilename: `certs/${process.env.BUCKET_KEY}`
});

const multerDoc = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 2 * 1024 * 1024, 
    },
});


const bucket = storage.bucket(process.env.PUBLIC_BUCKET_NAME);
const bucket_priv = storage_priv.bucket(process.env.BUCKET_NAME);

/** Vista modulo */
async function menuView(req, res){
    try{
        let cypheridapp = req.query.i;
        const decoded = await promisify(jwt.verify)(cypheridapp, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if(!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        let idapp = decoded.idapp;

        let paginas_registros = 1;

        const menus = await menuModel.menu.findAll({
            where: {
                fk_id_sysapp: idapp,
            },
            include: [
                {
                    model: sysappModel,
                    required: false
                }
            ]
        });

        res.render('../views/menu_cms', {
            ...req.usdata,
            menus,
            paginas_registros,
            app_seleccionada: idapp,
        });

    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
//*** menus estatales/independientes */
async function crearMenu(req, res) {
    try {
        const { fk_id_sysapp, nombre } = req.body;

        if (!fk_id_sysapp || !nombre) {
            return res.status(400).json({
                success: false,
                message: 'Campos requeridos: fk_id_sysapp, nombre'
            });
        }

        const nuevoMenu = await menuModel.menu.create({
            fk_id_sysapp: parseInt(fk_id_sysapp),
            nombre: nombre.trim() || 'Sin nombre',
            vigente: false
        });

        const menuCompleto = await menuModel.menu.findOne({
            where: { id_wb_menu: nuevoMenu.id_wb_menu },
            include: [
                { model: sysappModel, required: false },
                { model: menuModel.menuLinks, as: 'menus', required: false }
            ]
        });

        return res.json({
            success: true,
            menu: menuCompleto.get({ plain: true }) 
        });

    } catch (error) {
        console.error('Error en crearMenu:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al crear menú',
            error: error.message
        });
    }
}
async function cambiarEstatusMenu(req, res) {
    try {

        const {id_menu, id_sysapp} = req.body;
        const menusActivos = await menuModel.menu.findAll({
            where: {
                fk_id_sysapp: id_sysapp,
                vigente: true
            }
        });
        if (menusActivos.length >= 1 && menusActivos[0].id_wb_menu !== parseInt(id_menu)) {
            return res.status(500).json({
                success: false,
                message: 'Solo puede haber un menú activo por aplicación. Desactive el menú actual antes de activar otro.'
            });
        }

        const menuEncontrado = await menu.findByPk(id_menu, {
            include: [{ model: menuLinks, as: 'menus' }]
        });

        if (!menuEncontrado) {
            return res.status(404).json({ success: false, message: 'Menú no encontrado' });
        }

        menuEncontrado.vigente = !menuEncontrado.vigente;
        await menuEncontrado.save();
        return res.json({ success: true, message: 'Estado del menú actualizado correctamente' });
    } catch (error) {
        console.error("Error cambiando estado del menú:", error);
        return res.status(500).json({
            success: false,
            message: 'Error al cambiar estado del menú',
            error: error.message
        });
    }
}
async function menuDetalleView(req, res) {
    try {
        const menuId = req.query.menuId;
        if (!menuId) {
            return res.status(400).json({ success: false, error: 1, message: 'ID de menú no proporcionado' });
        }
        const menuRow = await menu.findOne({
            where: { id_wb_menu: menuId },
            attributes: ['fk_id_sysapp']
        });
        const fk_id_sysapp = menuRow ? menuRow.fk_id_sysapp : null;
        const [menuDetalle_lim, paginasInstancia] = await Promise.all([
            obtenerMenuPorNivel(menuId, null),
            fk_id_sysapp ? paginasModel.pagina.findAll({
                where: { fk_id_sysapp, vigente: true },
                attributes: ['id_wb_pagina', 'nombre_pagina', 'url_safe'],
                order: [['nombre_pagina', 'ASC']],
                raw: true
            }) : Promise.resolve([])
        ]);
        return res.render('../views/menu_cms_detalle', {
            ...req.usdata,
            menuDetalle_lim: menuDetalle_lim,
            menuId: menuId,
            paginasInstancia: paginasInstancia || []
        });

    } catch (error){
        console.error(error);
        return res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form();
    const result = { fields: {}, files: {} };

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      for (const key in fields) {
        result.fields[key] = fields[key].length === 1 ? fields[key][0] : fields[key];
      }
      result.files = files;
      resolve(result);
    });
  });
}

async function guardarMenuCompleto(req, res) {
    const transaction = await dbConection.transaction();
    try {
        const { menus, menuId } = req.body;
        const datosMenu = Array.isArray(menus) ? menus : JSON.parse(menus);

        const menuRow = await menu.findOne({
            where: { id_wb_menu: menuId },
            attributes: ['fk_id_sysapp'],
            transaction
        });
        const fk_id_sysapp = menuRow ? menuRow.fk_id_sysapp : null;

        // PRIMERO ELIMINAMOS LOS QUE YA NO SE QUIEREN
        const dbItems = await menuLinks.findAll({
            where: { fk_id_wb_menu: menuId },
            attributes: ['id_wb_menu_link'],
            transaction
        });
        const dbIds = dbItems.map(i => i.id_wb_menu_link);

        function extraerIds(items) {
            let ids = [];
            items.forEach(i => {
                if (i.id) ids.push(i.id);
                if (i.hijos && i.hijos.length) ids.push(...extraerIds(i.hijos));
            });
            return ids;
        }

        const frontendIds = extraerIds(datosMenu);
        const idsNoVigentes = dbIds.filter(id => !frontendIds.includes(id));

        if (idsNoVigentes.length > 0) {
            await menuLinks.update(
                { vigente: false },
                { where: { id_wb_menu_link: idsNoVigentes }, transaction }
            );
        }

        // LUEGO ACTUALIZAMOS O GUARDAMOS LOS NUEVOS NODOS
        async function guardarNodo(item, padreId = null, bandera = 'padre') {
            let url_imagen = null;
            let imagenFile = null;
            const nivel = parseInt(item.link_nivel) || 1;

            // fk_id_wb_pagina debe ser una página de esta instancia; si no existe, null (menú por instancia, se refleja en todas las páginas)
            let fk_id_wb_pagina_val = null;
            const idPag = item.fk_id_wb_pagina != null && item.fk_id_wb_pagina !== '' ? parseInt(item.fk_id_wb_pagina, 10) : null;
            if (idPag && !isNaN(idPag) && fk_id_sysapp != null) {
                const paginaExiste = await paginasModel.pagina.findOne({
                    where: { id_wb_pagina: idPag, fk_id_sysapp: fk_id_sysapp },
                    attributes: ['id_wb_pagina'],
                    transaction
                });
                if (paginaExiste) fk_id_wb_pagina_val = idPag;
            }

            // Solo procesar imágenes para nivel 1
            if (nivel === 1) {
                // Buscar archivo asociado a ESTE item.id en req.files
                if (req.files) {
                    if (Array.isArray(req.files)) {
                        imagenFile = req.files.find(f => f.fieldname === String(item.id)) || null;
                    } else if (typeof req.files === 'object') {
                        for (const arr of Object.values(req.files)) {
                            if (Array.isArray(arr)) {
                                const found = arr.find(f => f.fieldname === String(item.id));
                                if (found) {
                                    imagenFile = found;
                                    break;
                                }
                            }
                        }
                    }
                }

                // Si hay imagen nueva, la subimos y obtenemos URL
                if (imagenFile) {
                    const imagen = imagenFile;
                    const filename = `cdn/websites/menu_${Date.now()}_${imagen.originalname}`;
                    const blob = bucket.file(filename);
                    const blobStream = blob.createWriteStream({
                        resumable: false,
                        metadata: { contentType: imagen.mimetype }
                    });

                    await new Promise((resolve, reject) => {
                        blobStream.on('finish', resolve);
                        blobStream.on('error', reject);
                        blobStream.end(imagen.buffer);
                    });

                    url_imagen = `https://storage.googleapis.com/${process.env.PUBLIC_BUCKET_NAME}/${filename}`;
                }
            }

            // Datos comunes (fk_id_wb_pagina solo si existe en esta instancia)
            const updateData = {
                nombre: item.nombre?.trim() || 'Sin nombre',
                url_link: item.url_link || '',
                fk_id_wb_menu: menuId,
                link_nivel: nivel,
                fk_id_wb_pagina: fk_id_wb_pagina_val,
                id_cat_type_link: parseInt(item.id_cat_type_link) || 1,
                vigente: true,
                orden_visible: item.orden_visible || 0,
                fk_id_wb_menu_link_superior: bandera === 'hijo' ? parseInt(padreId) : null,
                fk_id_cat_type_users: [1]
            };

            // 🔹 SOLO tocamos url_imagen si HAY archivo nuevo Y es nivel 1
            if (url_imagen && nivel === 1) {
                updateData.url_imagen = url_imagen;
            } else if (nivel > 1) {
                // Para niveles superiores, asegurarse de que url_imagen no se modifique
                // Si es un elemento existente, mantener su url_imagen actual (null o vacío)
                const esNuevo = typeof item.id === 'string' && item.id.startsWith('nuevo-');
                if (!esNuevo) {
                    // Si es actualización y no hay imagen nueva, no tocamos url_imagen
                    // (no lo incluimos en updateData, así mantiene su valor actual en BD)
                } else {
                    // Si es nuevo y es nivel > 1, no debe tener imagen
                    updateData.url_imagen = null;
                }
            }

            const esNuevo = typeof item.id === 'string' && item.id.startsWith('nuevo-');
            let newItemId;

            if (esNuevo) {
                const created = await menuLinks.create(updateData, { transaction });
                newItemId = created.dataValues.id_wb_menu_link;
            } else {
                await menuLinks.update(updateData, {
                    where: { id_wb_menu_link: item.id, vigente: true },
                    transaction
                });
                newItemId = item.id ? item.id : 'eliminado';
            }

            // Guardar hijos recursivamente
            if (item.hijos && item.hijos.length > 0 && newItemId !== 'eliminado') {
                for (const hijo of item.hijos) {
                    await guardarNodo(hijo, newItemId, 'hijo');
                }
            }
        }

        // Guardar todos los menús de primer nivel
        for (const item of datosMenu) {
            await guardarNodo(item, menuId);
        }

        await transaction.commit();
        // Regenerar estáticos relacionados con el menú en segundo plano.
        const menuSysappId = fk_id_sysapp;
        setImmediate(() => {
            (async () => {
                try {
                    const objapp = global.catalogos?.cat_apps_activas
                        ? global.catalogos.cat_apps_activas.find(a => a.id_sysapp === menuSysappId)
                        : null;
                    if (!objapp) return;

                    // listado de entradas
                    await staticGenerator.generateAndSaveStaticHTMLForEntradasList(objapp);

                    // detalle de cada entrada publicada
                    const paginasEntradas = await paginasModel.pagina.findAll({
                        where: { fk_id_sysapp: menuSysappId, vigente: true, publicada: true, fk_id_cat_type_pagina: 5 },
                        attributes: ['id_wb_pagina', 'url_safe'],
                        raw: true
                    });
                    for (const p of paginasEntradas) {
                        if (p?.id_wb_pagina && p?.url_safe) {
                            await staticGenerator.generateAndSaveStaticHTMLForEntradaDetalle(objapp, p.id_wb_pagina, p.url_safe);
                        }
                    }

                    // Regenerar también páginas normales (home + páginas tipo 2)
                    const paginasNormales = await paginasModel.pagina.findAll({
                        where: {
                            fk_id_sysapp: menuSysappId,
                            vigente: true,
                            publicada: true,
                            fk_id_cat_type_pagina: { [Op.in]: [1, 2] }
                        },
                        attributes: ['id_wb_pagina', 'url_safe', 'fk_id_cat_type_pagina'],
                        raw: true
                    });
                    for (const p of paginasNormales) {
                        if (!p?.id_wb_pagina) continue;
                        await staticGenerator.generateAndSaveStaticHTML(objapp, p, p.url_safe || '/', p.fk_id_cat_type_pagina || 2);
                    }

                    // regeneración (si aplica)
                    await staticGenerator.generateAndSaveStaticHTMLForRegeneracion(objapp);
                } catch (regenErr) {
                    console.error('[guardarMenuCompleto] Error regenerando estáticos:', regenErr);
                }
            })();
        });

        return res.json({ success: true, message: 'Menús guardados correctamente' });
    } catch (error) {
        console.error(error);
        await transaction.rollback();
        return res.status(500).json({
            success: false,
            message: 'Error al guardar los menús',
            error: error.message
        });
    }
}



// En tu controller, agrega esta función:
async function subirImagenMenu(req, res) {
    try {
        const upload = multerDoc.single('imagen');
        
        return new Promise((resolve, reject) => {
            upload(req, res, async function(err) {
                if (err) {
                    return res.status(500).json({ success: false, message: 'Error al procesar imagen' });
                }

                try {
                    const { id_wb_menu_link } = req.body;
                    const file = req.file;

                    if (!file) {
                        return res.status(400).json({ success: false, message: 'No se recibió imagen' });
                    }

                    // Subir imagen a Google Cloud
                    const filename = `cdn/websites/menu_${Date.now()}_${file.originalname}`;
                    const blob = bucket.file(filename);
                    const blobStream = blob.createWriteStream({
                        resumable: false,
                        metadata: { contentType: file.mimetype }
                    });

                    await new Promise((resolve, reject) => {
                        blobStream.on('finish', resolve);
                        blobStream.on('error', reject);
                        blobStream.end(file.buffer);
                    });

                    const url_imagen = `https://storage.googleapis.com/${process.env.PUBLIC_BUCKET_NAME}/${filename}`;

                    // Actualizar en base de datos
                    await menuModel.menuLinks.update(
                        { url_imagen },
                        { where: { id_wb_menu_link } }
                    );

                    return res.json({
                        success: true,
                        url_imagen
                    });

                } catch (error) {
                    console.error('Error subirImagenMenu:', error);
                    return res.status(500).json({ 
                        success: false, 
                        message: 'Error al subir imagen' 
                    });
                }
            });
        });

    } catch (error) {
        console.error('Error general subirImagenMenu:', error);
        return res.status(500).json({ 
            success: false, 
            message: 'Error interno' 
        });
    }
}

async function actualizarReferenciasTemporales(req, res) {
    try {
        const { idTemporal, idReal } = req.body;

        if (!idTemporal || !idReal) {
            return res.status(400).json({
                success: false,
                message: 'IDs temporal y real son requeridos'
            });
        }

        // Actualizar todas las referencias que apuntaban al ID temporal
        await menuModel.menuLinks.update(
            { fk_id_wb_menu_link_superior: idReal },
            { 
                where: { 
                    fk_id_wb_menu_link_superior: idTemporal 
                } 
            }
        );

        return res.json({
            success: true,
            message: 'Referencias actualizadas correctamente'
        });

    } catch (error) {
        console.error('Error al actualizar referencias:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al actualizar referencias',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}
async function eliminarImagenMenu(req, res) {
    try {
        const { id_wb_menu_link } = req.body;
        
        if (!id_wb_menu_link) {
            return res.status(400).json({
                success: false,
                message: 'ID del elemento de menú es requerido'
            });
        }
        
        // Buscar el elemento del menú
        const menuItem = await menuModel.menuLinks.findByPk(id_wb_menu_link);
        
        if (!menuItem) {
            return res.status(404).json({
                success: false,
                message: 'Elemento de menú no encontrado'
            });
        }
        
        // Si hay una imagen, eliminar del almacenamiento
        if (menuItem.url_imagen) {
            try {
                // Extraer la ruta del archivo de la URL
                const url = new URL(menuItem.url_imagen);
                const filePath = decodeURIComponent(url.pathname.substring(1)); // Eliminar el slash inicial
                
                // Eliminar el archivo de Google Cloud Storage
                const file = bucket.file(filePath);
                const exists = await file.exists();
                
                if (exists[0]) {
                    await file.delete();
                    console.log(`Imagen eliminada: ${filePath}`);
                }
            } catch (error) {
                console.error('Error al eliminar la imagen del almacenamiento:', error);
                // Continuamos aunque falle la eliminación del archivo
            }
        }
        
        // Actualizar la base de datos
        await menuModel.menuLinks.update(
            { url_imagen: '' },
            { where: { id_wb_menu_link } }
        );
        
        return res.json({
            success: true,
            message: 'Imagen eliminada correctamente'
        });
        
    } catch (error) {
        console.error('Error al eliminar imagen:', error);
        return res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}
async function eliminarMenuItem(req, res) {
    try {
        const { id_wb_menu_link } = req.body;

        if (!id_wb_menu_link) {
            return res.status(400).json({
                success: false,
                message: 'ID del menú es requerido'
            });
        }

        const eliminarHijosRecursivamente = async (parentId) => {
            const hijos = await menuModel.menuLinks.findAll({
                where: { fk_id_wb_menu_link_superior: parentId }
            });

            for (const hijo of hijos) {
                await eliminarHijosRecursivamente(hijo.id_wb_menu_link);
                await menuModel.menuLinks.destroy({
                    where: { id_wb_menu_link: hijo.id_wb_menu_link }
                });
            }
        };

        await eliminarHijosRecursivamente(id_wb_menu_link);

        await menuModel.menuLinks.destroy({
            where: { id_wb_menu_link }
        });

        return res.json({
            success: true,
            message: 'Elemento y sus subniveles eliminados correctamente'
        });

    } catch (error) {
        console.error('Error al eliminar:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al eliminar el elemento',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}
async function guardarOrdenMenu(req, res) {
    try {
        const { orden } = req.body;
        
        if (!orden || typeof orden !== 'object') {
            return res.status(400).json({
                success: false,
                message: 'Datos de orden no válidos'
            });
        }
        
        // Actualizar el orden de cada elemento en la base de datos
        for (const [id, datos] of Object.entries(orden)) {
            // Si es un ID temporal (nuevo elemento), saltar
            if (id.startsWith('nuevo-') || id.startsWith('temp-')) {
                continue;
            }
            
            await menuModel.menuLinks.update(
                {
                    orden_visible: datos.orden,  // Cambiado de 'orden' a 'orden_visible'
                    link_nivel: datos.nivel
                },
                {
                    where: { id_wb_menu_link: id }
                }
            );
        }
        
        return res.json({
            success: true,
            message: 'Orden guardado correctamente'
        });
        
    } catch (error) {
        console.error('Error al guardar el orden:', error);
        return res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}

/**Para obtener los datos de mi menu*/
async function obtenerMenuFrontend(req, res) {
    try {
       
        const { pathname, host: hostFromBody, appId: appIdFromBody, i, detalle, tags: tagsRaw } = req.body || {};
        let appId;

        // Token puede venir en i o en detalle
        const token = i || detalle || tagsRaw;

        // Normalizar tags: puede venir como string "1,2,3" o uno solo
        let tags = [];
        if (tagsRaw) {
            if (Array.isArray(tagsRaw)) {
                tags = tagsRaw.filter(Boolean);
            } else {
                tags = String(tagsRaw)
                    .split(',')
                    .map(t => t.trim())
                    .filter(Boolean);
            }
        }

        // ============================
        // 1) SIN TOKEN → resolver por appId directo, URL (pathname + APP_BASE_URL o host)
        // ============================
        if (!token) {
            // Si viene appId directamente del frontend, usarlo (más confiable)
            if (appIdFromBody) {
                appId = parseInt(appIdFromBody);
                // console.log('AppId obtenido directamente del frontend:', appId);
            } else {
                // Si no viene appId, intentar resolverlo desde la URL
                // Obtener el host desde el header de la petición o del body
                const host = hostFromBody || req.get('host') || req.headers.host || '';
                const protocol = req.protocol || (req.secure ? 'https' : 'http');
                const fullHost = host ? `${protocol}://${host}` : '';

                let baseUrl = process.env.APP_BASE_URL || '';
                let fullUrl;

                // Si trae https:// se la quitamos
                if (baseUrl.startsWith('https://')) {
                    baseUrl = baseUrl.replace(/^https:\/\//, '');
                }
                if (baseUrl.startsWith('http://')) {
                    baseUrl = baseUrl.replace(/^http:\/\//, '');
                }

                const safePathname = pathname || '/';
                const cleanPathname = safePathname.startsWith('/')
                    ? safePathname.slice(1)
                    : safePathname;

                // Estrategia 1: Buscar por host completo (más confiable para páginas secundarias)
                let appRow = null;
                if (host) {
                    // Intentar con el host completo
                    appRow = await sysappModel.findOne({
                        where: { 
                            urluri: { [Op.like]: `%${host}%` }
                        },
                        raw: true,
                    });

                    // Si no se encontró, intentar con el host sin protocolo
                    if (!appRow) {
                        appRow = await sysappModel.findOne({
                            where: { 
                                urluri: host
                            },
                            raw: true,
                        });
                    }
                }

                // Estrategia 2: Buscar por el primer segmento del pathname + baseUrl
                if (!appRow && baseUrl) {
                    const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
                    const firstSegment = cleanPathname.split('/')[0] || '';
                    fullUrl = `${cleanBaseUrl}${firstSegment}`;
                    
                    appRow = await sysappModel.findOne({
                        where: { urluri: fullUrl },
                        raw: true,
                    });
                }

                // Estrategia 3: Buscar por la página actual usando url_safe
                if (!appRow && cleanPathname) {
                    // Buscar la página por url_safe (puede ser relativo o absoluto)
                    let paginaEncontrada = await paginasModel.pagina.findOne({
                        where: {
                            url_safe: safePathname,
                            publicada: true,
                            vigente: true
                        },
                        attributes: ['fk_id_sysapp'],
                        raw: true
                    });

                    // Si no se encontró con el pathname completo, intentar solo el último segmento
                    if (!paginaEncontrada && cleanPathname.includes('/')) {
                        const lastSegment = cleanPathname.split('/').pop();
                        paginaEncontrada = await paginasModel.pagina.findOne({
                            where: {
                                url_safe: lastSegment,
                                publicada: true,
                                vigente: true
                            },
                            attributes: ['fk_id_sysapp'],
                            raw: true
                        });
                    }

                    // Si aún no se encontró, intentar buscar sin el slash inicial
                    if (!paginaEncontrada && safePathname.startsWith('/')) {
                        const pathnameSinSlash = safePathname.slice(1);
                        paginaEncontrada = await paginasModel.pagina.findOne({
                            where: {
                                url_safe: pathnameSinSlash,
                                publicada: true,
                                vigente: true
                            },
                            attributes: ['fk_id_sysapp'],
                            raw: true
                        });
                    }

                    // También intentar con cada segmento del pathname
                    if (!paginaEncontrada && cleanPathname.includes('/')) {
                        const segmentos = cleanPathname.split('/').filter(s => s);
                        for (const segmento of segmentos) {
                            paginaEncontrada = await paginasModel.pagina.findOne({
                                where: {
                                    url_safe: segmento,
                                    publicada: true,
                                    vigente: true
                                },
                                attributes: ['fk_id_sysapp'],
                                raw: true
                            });
                            if (paginaEncontrada) break;
                        }
                    }

                    if (paginaEncontrada && paginaEncontrada.fk_id_sysapp) {
                        appRow = await sysappModel.findOne({
                            where: { id_sysapp: paginaEncontrada.fk_id_sysapp },
                            raw: true,
                        });
                    }
                }

                // Estrategia 4: Intentar con la URL base completa
                if (!appRow && baseUrl) {
                    appRow = await sysappModel.findOne({
                        where: { urluri: baseUrl.replace(/\/$/, '') },
                        raw: true,
                    });
                }

                if (!appRow) {
                    // console.error('No se pudo determinar la aplicación. Host:', host, 'Pathname:', pathname, 'BaseUrl:', baseUrl);
                    return res.status(404).json({
                        success: false,
                        message: 'No se pudo determinar la aplicación a partir de la URL',
                        debug: {
                            host: host,
                            pathname: pathname,
                            baseUrl: baseUrl
                        }
                    });
                }

                appId = appRow.id_sysapp;
            }

        // ============================
        // 2) CON TOKEN → resolver por token y, si hace falta, por id_wb_pagina
        // ============================
        } else {
            const decoded = await promisify(jwt.verify)(token, process.env.SECRET);
            if (!decoded) {
                return res.status(400).json({
                    success: false,
                    error: 1,
                    message: '"Alerta de JWT en petición"'
                });
            }

            const comparedates = utilFun.compareDates(decoded.date_comp);
            if (!comparedates) {
                return res.status(400).json({
                    success: false,
                    error: 1,
                    message: '"El tiempo de la sesión ha expirado, favor de recargar la página"'
                });
            }

            // Prioridad: si el frontend manda appId, usarlo siempre para que el menú corresponda
            // a la instancia actual (y no el fk_id_sysapp inferido desde el token).
            const parsedAppIdFromBody = appIdFromBody ? parseInt(appIdFromBody, 10) : null;
            if (parsedAppIdFromBody !== null && !Number.isNaN(parsedAppIdFromBody)) {
                appId = parsedAppIdFromBody;
            } else {
                // Primero intentamos con lo que venga en el token
                appId = decoded.idapp;

                // Si NO trae appId, usamos id_wb_pagina para buscar fk_id_sysapp
                if ((appId === undefined || appId === null) && decoded.id_wb_pagina) {
                    const pagina = await paginasModel.pagina.findOne({
                        where: {
                            id_wb_pagina: decoded.id_wb_pagina,
                        },
                        raw: true,
                    });

                    if (!pagina) {
                        return res.status(400).json({
                            success: false,
                            error: 1,
                            message: 'No se pudo determinar la aplicación desde id_wb_pagina'
                        });
                    }

                    appId = pagina.fk_id_sysapp;
                }
            }

            if (appId === undefined || appId === null) {
                return res.status(400).json({
                    success: false,
                    error: 1,
                    message: 'No fue posible resolver la aplicación (appId) para el menú'
                });
            }
        }

        // ============================
        // 3) Buscar menú por appId
        // ============================
        const menuId = await menuModel.menu.findOne({
            where: {
                fk_id_sysapp: appId,
                vigente: true,
            },
            raw: true,
        });

        if (!menuId) {
            // console.log('No se encontró menú activo para appId:', appId);
            return res.status(200).json({
                data: [],
                success: true,
            });
        }

        // console.log('Menú encontrado - ID:', menuId.id_wb_menu, 'AppId:', appId);

        // Le pasamos tags como 3er parámetro por si tu función lo usa
        const menuFinal = await obtenerMenuPorNivel(menuId.id_wb_menu, null, tags);

        // console.log('Items del menú obtenidos:', menuFinal ? menuFinal.length : 0, 'items');
        // if (menuFinal && menuFinal.length > 0) {
        //     console.log('Primer item del menú:', JSON.stringify(menuFinal[0], null, 2));
        // } else {
        //     console.log('El menú está vacío - verificando si hay items en la BD...');
        //     // Verificar si hay items en la BD para este menú
        //     const totalItems = await menuModel.menuLinks.count({
        //         where: {
        //             fk_id_wb_menu: menuId.id_wb_menu,
        //             vigente: true
        //         }
        //     });
        //     console.log('Total de items vigentes en BD para este menú:', totalItems);
        // }

        return res.status(200).json({
            data: menuFinal || [],
            success: true,
        });
    } catch (error) {
        console.error('Error al obtener menú para frontend:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener menú'
        });
    }
}


async function obtenerMenuPorNivel(menu_id, fk_id_padre = null, tags = null) {
    const idPadreABuscar = (fk_id_padre === null || fk_id_padre === 0) 
        ? { [Op.or]: [null, 0] }
        : fk_id_padre;
    
    const whereCondition = {
        fk_id_wb_menu: menu_id,
        fk_id_wb_menu_link_superior: idPadreABuscar,
        vigente: true
    };

    const hijos = await menuModel.menuLinks.findAll({
        where: whereCondition,
        order: [['orden_visible', 'ASC']],
        raw: true,
    });

    // console.log(`obtenerMenuPorNivel - menu_id: ${menu_id}, fk_id_padre: ${fk_id_padre}, items encontrados: ${hijos.length}`);

    for (const link of hijos) {
        link.submenus = await obtenerMenuPorNivel(menu_id, link.id_wb_menu_link, tags);
    }

    return hijos;
}

module.exports = {
    menuView,
    cambiarEstatusMenu,
    menuDetalleView,
    guardarMenuCompleto,  
    eliminarMenuItem,
    crearMenu,
    guardarOrdenMenu,
    obtenerMenuFrontend,
    actualizarReferenciasTemporales, 
    eliminarImagenMenu 
};