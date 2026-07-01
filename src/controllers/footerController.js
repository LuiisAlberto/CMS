const {promisify} = require("util");
const jwt = require("jsonwebtoken");
const utilFun = require("../util/util");
const footerModel = require("../models/footerModel");
const sysappModel = require("../models/AppsModel");
const multer = require('multer');
const { Storage } = require('@google-cloud/storage'); 
const path = require('path');
const multiparty = require('multiparty');
const fs = require('fs');
const { Op } = require('sequelize');
const { footer, footerLinks } = require('../models/footerModel.js');
const dbConection = require('../config/postgressdb');

const storage = new Storage({
    projectId: process.env.PUBLIC_BUCKET_NAME,
    keyFilename: `certs/${process.env.PUBLIC_BUCKET_KEY}`
});

const bucket = storage.bucket(process.env.PUBLIC_BUCKET_NAME);

const multerDoc = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 2 * 1024 * 1024, 
    },
});

/** Vista módulo - Lista de footers */
async function footerView(req, res){
    try{
        let cypheridapp = req.query.i;
        const decoded = await promisify(jwt.verify)(cypheridapp, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if(!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        let idapp = decoded.idapp;

        const footers = await footerModel.footer.findAll({
            where: {
                fk_id_sysapp: idapp,
            },
            include: [
                {
                    model: sysappModel,
                    required: false
                },
                {
                    model: footerModel.footerLinks,
                    as: 'enlaces',
                    required: false
                }
            ],
            order: [['f_reg', 'DESC']]
        });

        res.render('../views/footer_cms', {
            ...req.usdata,
            footers,
            app_seleccionada: idapp,
            token: cypheridapp, // Pasar el token a la vista
        });

    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

/** Crear nuevo footer */
async function crearFooter(req, res) {
    try {
        const { fk_id_sysapp, nombre } = req.body;

        if (!fk_id_sysapp || !nombre) {
            return res.status(400).json({
                success: false,
                message: 'Campos requeridos: fk_id_sysapp, nombre'
            });
        }

        const nuevoFooter = await footerModel.footer.create({
            fk_id_sysapp: parseInt(fk_id_sysapp),
            nombre: nombre.trim() || 'Sin nombre',
            vigente: false
        });

        const footerCompleto = await footerModel.footer.findOne({
            where: { id_wb_footer: nuevoFooter.id_wb_footer },
            include: [
                { model: sysappModel, required: false },
                { model: footerModel.footerLinks, as: 'enlaces', required: false }
            ]
        });

        return res.json({
            success: true,
            footer: footerCompleto.get({ plain: true }) 
        });

    } catch (error) {
        console.error('Error en crearFooter:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al crear footer',
            error: error.message
        });
    }
}

/** Cambiar estatus del footer (activar/desactivar) */
async function cambiarEstatusFooter(req, res) {
    try {
        const {id_footer, id_sysapp} = req.body;
        
        // Solo puede haber un footer activo por aplicación
        const footersActivos = await footerModel.footer.findAll({
            where: {
                fk_id_sysapp: id_sysapp,
                vigente: true
            }
        });
        
        if (footersActivos.length >= 1 && footersActivos[0].id_wb_footer !== parseInt(id_footer)) {
            return res.status(500).json({
                success: false,
                message: 'Solo puede haber un footer activo por aplicación. Desactive el footer actual antes de activar otro.'
            });
        }

        const footerEncontrado = await footer.findByPk(id_footer, {
            include: [{ model: footerLinks, as: 'enlaces' }]
        });

        if (!footerEncontrado) {
            return res.status(404).json({ success: false, message: 'Footer no encontrado' });
        }

        footerEncontrado.vigente = !footerEncontrado.vigente;
        await footerEncontrado.save();
        
        return res.json({ 
            success: true, 
            message: 'Estado del footer actualizado correctamente' 
        });
    } catch (error) {
        console.error("Error cambiando estado del footer:", error);
        return res.status(500).json({
            success: false,
            message: 'Error al cambiar estado del footer',
            error: error.message
        });
    }
}

/** Vista detalle del footer */
async function footerDetalleView(req, res) {
    try {
        const footerId = req.query.footerId;
        if (!footerId) {
            return res.status(400).json({ success: false, error: 1, message: 'ID de footer no proporcionado' });
        }
        
        const footerDetalle = await footerModel.footer.findOne({
            where: { id_wb_footer: footerId },
            include: [
                {
                    model: footerModel.footerLinks,
                    as: 'enlaces',
                    required: false,
                    where: { vigente: true }
                }
            ]
        });

        // Ordenar enlaces después de obtenerlos
        if (footerDetalle && footerDetalle.enlaces) {
            footerDetalle.enlaces.sort((a, b) => {
                // Primero por categoría
                const catA = (a.categoria || '').toLowerCase();
                const catB = (b.categoria || '').toLowerCase();
                if (catA !== catB) {
                    return catA.localeCompare(catB);
                }
                // Luego por orden_visible
                return (a.orden_visible || 0) - (b.orden_visible || 0);
            });
        }

        if (!footerDetalle) {
            return res.status(404).json({ success: false, error: 1, message: 'Footer no encontrado' });
        }

        // Obtener el token de la query string para pasarlo a la vista
        const token = req.query.i || null;

        return res.render('../views/footer_cms_detalle', {
            ...req.usdata,
            footerDetalle: footerDetalle.get({ plain: true }),
            footerId: footerId,
            token: token
        })

    } catch (error){
        console.error(error);
        return res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

/** Guardar footer completo */
async function guardarFooterCompleto(req, res) {
    const transaction = await dbConection.transaction();
    try {
        const { 
            footerId, 
            nombre, 
            texto_suscripcion, 
            email_contacto, 
            telefono_contacto, 
            direccion_contacto,
            texto_copyright,
            enlaces: enlacesRaw,
            categoria_enlaces: categoria_enlacesRaw
        } = req.body;

        // Parsear enlaces y categorías (vienen como JSON strings desde FormData)
        let enlaces = [];
        let categoria_enlaces = [];
        
        try {
            if (enlacesRaw) {
                enlaces = typeof enlacesRaw === 'string' ? JSON.parse(enlacesRaw) : enlacesRaw;
            }
            if (categoria_enlacesRaw) {
                categoria_enlaces = typeof categoria_enlacesRaw === 'string' ? JSON.parse(categoria_enlacesRaw) : categoria_enlacesRaw;
            }
        } catch (parseError) {
            console.error('Error al parsear enlaces:', parseError);
            await transaction.rollback();
            return res.status(400).json({ 
                success: false, 
                message: 'Error al procesar los enlaces',
                error: parseError.message 
            });
        }

        // Buscar el footer
        const footerExistente = await footerModel.footer.findByPk(footerId, { transaction });
        if (!footerExistente) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: 'Footer no encontrado' });
        }

        // Procesar logo si viene
        let url_logo = footerExistente.url_logo;
        if (req.files && req.files.length > 0) {
            const logoFile = req.files.find(f => f.fieldname === 'logo');
            if (logoFile) {
                const filename = `cdn/websites/footer_${Date.now()}_${logoFile.originalname}`;
                const blob = bucket.file(filename);
                const blobStream = blob.createWriteStream({
                    resumable: false,
                    metadata: { contentType: logoFile.mimetype }
                });

                await new Promise((resolve, reject) => {
                    blobStream.on('finish', resolve);
                    blobStream.on('error', reject);
                    blobStream.end(logoFile.buffer);
                });

                url_logo = `https://storage.googleapis.com/${process.env.PUBLIC_BUCKET_NAME}/${filename}`;
            }
        }

        // Actualizar datos del footer
        await footerModel.footer.update({
            nombre: nombre?.trim() || footerExistente.nombre,
            url_logo: url_logo,
            texto_suscripcion: texto_suscripcion || '',
            email_contacto: email_contacto || '',
            telefono_contacto: telefono_contacto || '',
            direccion_contacto: direccion_contacto || '',
            texto_copyright: texto_copyright || '© 2023 MORENA. Todos los derechos reservados. Aviso de Privacidad'
        }, {
            where: { id_wb_footer: footerId },
            transaction
        });

        // Procesar enlaces
        if (enlaces && Array.isArray(enlaces) && enlaces.length > 0) {
            // Eliminar enlaces que ya no están en la lista
            const enlacesActuales = await footerModel.footerLinks.findAll({
                where: { fk_id_wb_footer: footerId },
                attributes: ['id_wb_footer_link'],
                transaction
            });
            const idsActuales = enlacesActuales.map(e => e.id_wb_footer_link);
            const idsNuevos = enlaces
                .filter(e => e.id && !e.id.toString().startsWith('nuevo-'))
                .map(e => parseInt(e.id));
            
            const idsAEliminar = idsActuales.filter(id => !idsNuevos.includes(id));
            if (idsAEliminar.length > 0) {
                await footerModel.footerLinks.update(
                    { vigente: false },
                    { where: { id_wb_footer_link: idsAEliminar }, transaction }
                );
            }

            // Guardar o actualizar enlaces
            for (let i = 0; i < enlaces.length; i++) {
                const enlace = enlaces[i];
                const categoria = categoria_enlaces && categoria_enlaces[i] ? categoria_enlaces[i] : '';

                if (enlace.id && enlace.id.toString().startsWith('nuevo-')) {
                    // Nuevo enlace
                    await footerModel.footerLinks.create({
                        fk_id_wb_footer: footerId,
                        nombre: enlace.nombre?.trim() || '',
                        url_link: enlace.url_link || '',
                        categoria: categoria || '',
                        orden_visible: i + 1,
                        vigente: true
                    }, { transaction });
                } else if (enlace.id) {
                    // Actualizar enlace existente
                    await footerModel.footerLinks.update({
                        nombre: enlace.nombre?.trim() || '',
                        url_link: enlace.url_link || '',
                        categoria: categoria || '',
                        orden_visible: i + 1,
                        vigente: true
                    }, {
                        where: { id_wb_footer_link: enlace.id },
                        transaction
                    });
                }
            }
        } else if (enlaces && Array.isArray(enlaces) && enlaces.length === 0) {
            // Si se envía un array vacío, desactivar todos los enlaces existentes
            await footerModel.footerLinks.update(
                { vigente: false },
                { where: { fk_id_wb_footer: footerId }, transaction }
            );
        }

        await transaction.commit();

        // Token fresco para /footer?i=... (el JWT del menú usa date_comp = mismo día;
        // si el usuario edita largo tiempo o cruza medianoche, el token viejo falla en compareDates).
        const redirectToken = jwt.sign(
            {
                idapp: footerExistente.fk_id_sysapp,
                date_comp: new Date(),
            },
            process.env.SECRET
        );

        return res.json({
            success: true,
            message: 'Footer guardado correctamente',
            redirectToken,
        });
    } catch (error) {
        console.error(error);
        await transaction.rollback();
        return res.status(500).json({
            success: false,
            message: 'Error al guardar el footer',
            error: error.message
        });
    }
}

/** Obtener footer para frontend */
async function obtenerFooterFrontend(req, res) {
    try {
        const { pathname, host: hostFromBody, appId: appIdFromBody, i, detalle, tags: tagsRaw } = req.body || {};
        let appId;

        // Token puede venir en i o en detalle.
        // Nota: NO usar `tags`/`v` como token de app; en varias páginas `v` es un token de tag
        // (o un parámetro no relacionado a la instancia) y eso puede dejar decoded.idapp undefined.
        const token = i || detalle;

        // Resolver appId (misma lógica que el menú)
        if (token) {
            const decoded = await promisify(jwt.verify)(token, process.env.SECRET);
            if (!decoded) {
                return res.status(400).json({
                    success: false,
                    error: 1,
                    message: 'Alerta de JWT en petición'
                });
            }

            const comparedates = utilFun.compareDates(decoded.date_comp);
            if (!comparedates) {
                return res.status(400).json({
                    success: false,
                    error: 1,
                    message: 'El tiempo de la sesión ha expirado'
                });
            }

            appId = decoded.idapp;
        }

        // Fallback si token no trajo appId o no hay token: usar appId del body o host.
        if (!appId) {
            if (appIdFromBody) {
                appId = parseInt(appIdFromBody, 10);
            } else {
                const host = hostFromBody || req.get('host') || req.headers.host || '';
                let baseUrl = process.env.APP_BASE_URL || '';
                
                if (baseUrl.startsWith('https://')) {
                    baseUrl = baseUrl.replace(/^https:\/\//, '');
                }
                if (baseUrl.startsWith('http://')) {
                    baseUrl = baseUrl.replace(/^http:\/\//, '');
                }

                let appRow = null;
                if (host) {
                    appRow = await sysappModel.findOne({
                        where: { 
                            urluri: { [Op.like]: `%${host}%` }
                        },
                        raw: true,
                    });
                    if (!appRow) {
                        appRow = await sysappModel.findOne({
                            where: { urluri: host },
                            raw: true,
                        });
                    }
                }

                if (!appRow && baseUrl) {
                    appRow = await sysappModel.findOne({
                        where: { urluri: baseUrl.replace(/\/$/, '') },
                        raw: true,
                    });
                }

                if (!appRow) {
                    return res.status(404).json({
                        success: false,
                        message: 'No se pudo determinar la aplicación'
                    });
                }

                appId = appRow.id_sysapp;
            }
        }

        if (!appId || isNaN(appId)) {
            return res.status(404).json({
                success: false,
                message: 'No se pudo determinar la aplicación (appId inválido)'
            });
        }

        // Buscar footer activo
        const footerActivo = await footerModel.footer.findOne({
            where: {
                fk_id_sysapp: appId,
                vigente: true,
            },
            include: [
                {
                    model: footerModel.footerLinks,
                    as: 'enlaces',
                    where: { vigente: true },
                    required: false
                }
            ],
            raw: false
        });

        // Ordenar enlaces después de obtenerlos
        if (footerActivo && footerActivo.enlaces) {
            footerActivo.enlaces.sort((a, b) => {
                // Primero por categoría
                const catA = (a.categoria || '').toLowerCase();
                const catB = (b.categoria || '').toLowerCase();
                if (catA !== catB) {
                    return catA.localeCompare(catB);
                }
                // Luego por orden_visible
                return (a.orden_visible || 0) - (b.orden_visible || 0);
            });
        }

        if (!footerActivo) {
            return res.status(200).json({
                data: null,
                success: true,
            });
        }

        // Organizar enlaces por categoría
        const enlacesPorCategoria = {};
        if (footerActivo.enlaces && footerActivo.enlaces.length > 0) {
            footerActivo.enlaces.forEach(enlace => {
                const categoria = enlace.categoria || 'General';
                if (!enlacesPorCategoria[categoria]) {
                    enlacesPorCategoria[categoria] = [];
                }
                enlacesPorCategoria[categoria].push({
                    id: enlace.id_wb_footer_link,
                    nombre: enlace.nombre,
                    url_link: enlace.url_link,
                    categoria: enlace.categoria
                });
            });
        }

        const footerData = {
            id: footerActivo.id_wb_footer,
            nombre: footerActivo.nombre,
            url_logo: footerActivo.url_logo,
            texto_suscripcion: footerActivo.texto_suscripcion,
            email_contacto: footerActivo.email_contacto,
            telefono_contacto: footerActivo.telefono_contacto,
            direccion_contacto: footerActivo.direccion_contacto,
            texto_copyright: footerActivo.texto_copyright,
            enlaces_por_categoria: enlacesPorCategoria
        };

        return res.status(200).json({
            data: footerData,
            success: true,
        });
    } catch (error) {
        console.error('Error al obtener footer para frontend:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener footer'
        });
    }
}

/** Eliminar enlace del footer */
async function eliminarEnlaceFooter(req, res) {
    try {
        const { id_enlace } = req.body;

        if (!id_enlace) {
            return res.status(400).json({
                success: false,
                message: 'ID del enlace es requerido'
            });
        }

        await footerModel.footerLinks.update(
            { vigente: false },
            { where: { id_wb_footer_link: id_enlace } }
        );

        return res.json({
            success: true,
            message: 'Enlace eliminado correctamente'
        });

    } catch (error) {
        console.error('Error al eliminar enlace:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al eliminar el enlace',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}

/** Eliminar logo del footer */
async function eliminarLogoFooter(req, res) {
    try {
        const { id_footer } = req.body;
        
        if (!id_footer) {
            return res.status(400).json({
                success: false,
                message: 'ID del footer es requerido'
            });
        }
        
        const footerEncontrado = await footerModel.footer.findByPk(id_footer);
        
        if (!footerEncontrado) {
            return res.status(404).json({
                success: false,
                message: 'Footer no encontrado'
            });
        }
        
        // Si hay una imagen, eliminar del almacenamiento
        if (footerEncontrado.url_logo) {
            try {
                const url = new URL(footerEncontrado.url_logo);
                const filePath = decodeURIComponent(url.pathname.substring(1));
                
                const file = bucket.file(filePath);
                const exists = await file.exists();
                
                if (exists[0]) {
                    await file.delete();
                }
            } catch (error) {
                console.error('Error al eliminar la imagen del almacenamiento:', error);
            }
        }
        
        // Actualizar la base de datos
        await footerModel.footer.update(
            { url_logo: null },
            { where: { id_wb_footer: id_footer } }
        );
        
        return res.json({
            success: true,
            message: 'Logo eliminado correctamente'
        });
        
    } catch (error) {
        console.error('Error al eliminar logo:', error);
        return res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}

module.exports = {
    footerView,
    crearFooter,
    cambiarEstatusFooter,
    footerDetalleView,
    guardarFooterCompleto,
    obtenerFooterFrontend,
    eliminarEnlaceFooter,
    eliminarLogoFooter
};
