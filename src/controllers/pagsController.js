const paginaModel = require('../models/paginasModel');
const usersModel = require('../models/users');
const tipoPaginaModel = require('../models/tipo_pagsModel');
const filesModel = require('../models/files');
const { Op, Sequelize } = require('sequelize');
const dbConection = require('../config/postgressdb');
const storage_files = require("../models/storage_files");
const { promisify } = require("util");
const jwt = require("jsonwebtoken");
const { Storage } = require('@google-cloud/storage');
const Multer = require('multer');
const multerGoogleStorage = require('multer-google-storage');
const { rel_wb_tag_pagina, pagina } = require("../models/paginasModel");
const utilFun = require('../util/util');
const { DEFAULT_CIPHERS } = require('tls');
const { type } = require('os');
const { url } = require('inspector');
const { paginate } = require('../util/util');
const { decode } = require('punycode');
const { raw } = require('express');
const { table } = require('console');
const HostingModel = require('../models/HostingModel');
const {
    getEditorPaginaScopeDetail,
    isPaginaDeniedByScopeDetail,
    isPaginaTipoDeniedForEditor,
    TIPO_REGENERACION,
} = require('../util/editorPaginaScope');
const { normalizeColorAccent } = require('../util/colorAccent');
const { isFullWidthComponentType } = require('../util/componentMinSizes');
const { registraBitacora, ACCION: BITACORA_ACCION } = require('../util/bitacora');

const TIPOS_BITACORA_PAGINA = new Set([1, 2, 5]);

function dispararBitacoraPaginaAlta(id_user_actor, idapp, id_wb_pagina, fk_id_cat_type_pagina, req) {
    const actor = parseInt(id_user_actor, 10);
    const idPag = parseInt(id_wb_pagina, 10);
    const idSys = parseInt(idapp, 10);
    const tipo = Number(fk_id_cat_type_pagina);
    if (!Number.isFinite(actor) || !Number.isFinite(idPag) || !Number.isFinite(idSys)) return;
    if (!TIPOS_BITACORA_PAGINA.has(tipo)) return;
    void registraBitacora({
        fk_id_user_actor: actor,
        accion: BITACORA_ACCION.PAGINA_ALTA,
        fk_id_sysapp: idSys,
        id_wb_pagina: idPag,
        fk_id_cat_type_pagina: tipo,
        req: req || null,
    });
}

/** Alcance por lista de ids (no «todas»); null = sin filtro por ids */
function idsFromScopeRule(rule) {
    if (!rule || rule.all) return null;
    if (Array.isArray(rule.pageIds) && rule.pageIds.length) return rule.pageIds.map((n) => Number(n));
    if (rule.pageId != null && rule.pageId !== '') return [Number(rule.pageId)];
    return [];
}

const storage = new Storage({
    projectId: process.env.PUBLIC_BUCKET_NAME,
    keyFilename: `certs/${process.env.PUBLIC_BUCKET_KEY}`
});
const multer = Multer({
    storage: Multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5mb
    },
});
const bucket = storage.bucket(process.env.PUBLIC_BUCKET_NAME);




/** Vista de relación de páginas */
async function paginasList(req, res) {
    try {
        let cypheridapp = req.query.i;
        const decoded = await promisify(jwt.verify)(cypheridapp, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let idapp = decoded.idapp;

        const scopeDetail = await getEditorPaginaScopeDetail(req.usdata.id_user, idapp);
        const tiposEditor = scopeDetail
            ? Object.keys(scopeDetail)
                  .map((k) => parseInt(k, 10))
                  .filter((n) => Number.isFinite(n))
            : null;
        const allowPrincipal = !tiposEditor || tiposEditor.includes(1);
        const allowInterior = !tiposEditor || tiposEditor.includes(2);
        const allowEntrada = !tiposEditor || tiposEditor.includes(5);
        const allowRegeneracion = !tiposEditor || tiposEditor.includes(TIPO_REGENERACION);

        // "No debe existir ningún registro en rel_wb_pag_borrador donde fk_pag_nueva coincida con la id de esta página y sea tipo edición (tipo = 1)".
        const tagsWhereEntradas = {
            fk_id_cat_type_tag: 2,
            vigente: true,
            [Op.or]: [
                { fk_id_sysapp_type: idapp },
                { fk_id_sysapp_type: null }
            ]
        };
        const tags = await paginaModel.cat_tags.findAll({
            where: tagsWhereEntradas,
            order: [
                ['tag', 'asc']
            ]
        });
        // Optimizamos: factorizar consultas muy similares en una sola función utilitaria
        async function getPaginasPorTipo(whereOverrides) {
            return await paginaModel.pagina.findAll({
                attributes: [
                    'id_wb_pagina',
                    'nombre_pagina',
                    'fk_id_cat_type_pagina',
                    'fk_id_user',
                    'url_safe',
                    'publicada',
                    'f_publicacion',
                    [Sequelize.literal(`"wb_pagina"."f_reg"::DATE`), 'f_reg_date'],
                    [Sequelize.literal(`(
                        SELECT p.publicada
                        FROM rel_wb_pag_borrador b
                        JOIN wb_pagina p ON p.id_wb_pagina = b.fk_pag_nueva
                        WHERE b.fk_pag_origen = "wb_pagina".id_wb_pagina
                        AND b.fk_id_cat_pag_tipo_borrador = 1
                        AND b.vigente = true
                        LIMIT 1
                    )`), 'borrador_publicada'],
                    [Sequelize.literal(`(
                        SELECT p.nombre_pagina
                        FROM rel_wb_pag_borrador b
                        JOIN wb_pagina p ON p.id_wb_pagina = b.fk_pag_nueva
                        WHERE b.fk_pag_origen = "wb_pagina".id_wb_pagina
                        AND b.fk_id_cat_pag_tipo_borrador = 1
                        AND b.vigente = true
                        LIMIT 1
                    )`), 'nombre_pagina_borrador']
                ],
                where: {
                    fk_id_sysapp: idapp,
                    fk_id_cat_type_pagina: [1, 2],
                    vigente: true,
                    // Ocultar páginas que SON borradores (tipo 1) para no duplicar registros en el listado.
                    // El borrador se representa por rel_wb_pag_borrador.fk_pag_nueva = wb_pagina.id_wb_pagina
                    [Op.and]: Sequelize.literal(`
                        NOT EXISTS (
                            SELECT 1
                            FROM rel_wb_pag_borrador b
                            WHERE b.fk_pag_nueva = "wb_pagina".id_wb_pagina
                            AND b.fk_id_cat_pag_tipo_borrador = 1
                            AND b.vigente = true
                        )
                    `),
                    ...whereOverrides
                },
                include: [
                    {
                        attributes: ['nombre', 'primer_apellido', 'segundo_apellido'],
                        model: usersModel,
                        as: 'usuario',
                        required: false
                    },
                    {
                        model: paginaModel.rel_wb_pag_borrador,
                        as: 'duplicado',
                        required: false,
                        attributes: [],
                        where: {
                            fk_pag_nueva: { [Op.eq]: Sequelize.col('wb_pagina.id_wb_pagina') },
                            fk_id_cat_pag_tipo_borrador: 2
                        }
                    },
                    { // Solo traer un id borrador cuando sea tipo edición
                        model: paginaModel.rel_wb_pag_borrador,
                        as: 'borrador_existente',
                        required: false,
                        attributes: ['id_rel_wb_pag_borrador', 'fk_pag_nueva'],
                        where: {
                            fk_pag_origen: { [Op.eq]: Sequelize.col('wb_pagina.id_wb_pagina') },
                            fk_id_cat_pag_tipo_borrador: 1,
                            vigente: true
                        },
                    },
                ],
                order: [
                    ['fk_id_cat_type_pagina', 'asc'],
                    ['publicada', 'asc'],
                    ['f_publicacion', 'desc'],
                ],
                distinct: true,
                //logging: // console.log
            });
        }

        const paginainicial = await getPaginasPorTipo({
            url_safe: '/'
        });

        const paginaslist = await getPaginasPorTipo({
            url_safe: { [Op.ne]: '/' }
        });
        const entradaslist = await paginaModel.pagina.findAll({
            attributes: ['id_wb_pagina', 'nombre_pagina', 'fk_id_cat_type_pagina', 'fk_id_user', 'url_safe', 'publicada', 'f_publicacion',
                [Sequelize.literal(`"wb_pagina"."f_reg"::DATE`), 'f_reg_date']
            ], where: {
                fk_id_sysapp: idapp,
                fk_id_cat_type_pagina: [5],
                vigente: true,
            },
            // Todas las entradas (sin límite), más recientes primero: orden DESC por alta en CMS
            order: [
                ['f_reg', 'DESC'],
                ['id_wb_pagina', 'DESC'],
            ],
            include: [{
                attributes: ['nombre', 'primer_apellido', 'segundo_apellido'],
                model: usersModel,
                as: 'usuario',
                required: false
            }],
            //logging: // console.log
        });

        const regeneracionlist = await paginaModel.documento.findAll({
            attributes: [
                'id_wb_doc',
                'nombre',
                'contenido_alt',
                'f_publicacion',
                [Sequelize.literal(`"wb_docs"."f_reg"::DATE`), 'f_reg'],
                // Obtener año desde rel_wb_tag_doc
                [Sequelize.literal(`(
                    SELECT r.anio 
                    FROM rel_wb_tag_doc r 
                    WHERE r.fk_id_wb_doc = "wb_docs".id_wb_doc 
                    AND r.fk_id_cat_tag = 13 
                    AND r.vigente = true
                    LIMIT 1
                )`), 'year'],
                // Obtener bimestre
                [Sequelize.literal(`(
                    SELECT r.fk_id_cat_bimestre 
                    FROM rel_wb_tag_doc r 
                    WHERE r.fk_id_wb_doc = "wb_docs".id_wb_doc 
                    AND r.fk_id_cat_tag = 13 
                    AND r.vigente = true
                    LIMIT 1
                )`), 'bimestre']
            ],
            where: {
                fk_id_sysapp: idapp,
                vigente: true,
                // Solo documentos con tag 13 (regeneración) y que no tengan tag 14 (imagen)
                [Op.and]: [
                    Sequelize.literal(`
                        EXISTS (
                            SELECT 1 FROM rel_wb_tag_doc r 
                            WHERE r.fk_id_wb_doc = "wb_docs".id_wb_doc 
                            AND r.fk_id_cat_tag = 13
                            AND r.vigente = true
                        )
                    `),
                    Sequelize.literal(`
                        NOT EXISTS (
                            SELECT 1 FROM rel_wb_tag_doc r 
                            WHERE r.fk_id_wb_doc = "wb_docs".id_wb_doc 
                            AND r.fk_id_cat_tag = 14
                            AND r.vigente = true
                        )
                    `)
                ]
            },
            order: [
                [Sequelize.literal('"year"'), 'desc'],
                [Sequelize.literal('"bimestre"'), 'desc']
            ],
            include: [
                {
                    attributes: ['nombre', 'primer_apellido', 'segundo_apellido'],
                    model: usersModel,
                    as: 'usuariodoc',
                    required: false
                },
                {
                    model: filesModel.filesMain,
                    as: 'archivodoc',
                    required: false,
                    attributes: ['file_path']
                }
            ],
        });

        const bimestres = await paginaModel.cat_bimestres.findAll({
            where: {
                vigente: true,
            },
            order: [
                ['num_bimestre', 'asc']
            ]
        });

        const hostingInst = await HostingModel.findOne({
            where: { fk_id_sysapp: idapp },
            attributes: ['fk_id_estatus_hosting'],
            raw: true
        });
        const tieneDominio = !!(hostingInst && hostingInst.fk_id_estatus_hosting === 2);
        const instanciaActualNombre =
            (req.usdata &&
                req.usdata.modulos &&
                req.usdata.modulos[idapp] &&
                req.usdata.modulos[idapp].app_name)
                ? req.usdata.modulos[idapp].app_name
                : '';

        for (const pagina of paginainicial) {
            // Obtener estatus del borrador si existe
            let borradorPub = (pagina.dataValues && pagina.dataValues.borrador_publicada !== undefined)
                ? pagina.dataValues.borrador_publicada
                : null;

            // Normalizar el valor de publicada a booleano estricto
            // Si existe borrador_publicada (no nulo), usamos ese. Si no, usamos el de la página.
            let rawPub;
            if (borradorPub !== null) {
                rawPub = borradorPub;
            } else {
                rawPub = (pagina.dataValues && pagina.dataValues.publicada !== undefined)
                    ? pagina.dataValues.publicada
                    : (pagina.publicada !== undefined ? pagina.publicada : null);
            }

            // Considerar true si es true, 1, o string "true"
            const isPublished = (rawPub === true || rawPub === 1 || rawPub === 'true');

            // Asignar el valor normalizado
            pagina.publicada = isPublished;
            if (pagina.dataValues) {
                pagina.dataValues.publicada = isPublished;
            }

            pagina.idpagcy = jwt.sign(
                {
                    id_wb_pagina: pagina.id_wb_pagina,
                    idapp: idapp,
                    date_comp: new Date()
                },
                process.env.SECRET
            );
            pagina.dataValues.tiene_borrador = !!pagina.borrador_existente;
            pagina.dataValues.id_borrador = pagina.borrador_existente?.fk_pag_nueva || null;
        }
        for (const paginaint of paginaslist) {
            paginaint.idpagcy = jwt.sign(
                {
                    id_wb_pagina: paginaint.id_wb_pagina,
                    idapp: idapp,
                    date_comp: new Date()
                },
                process.env.SECRET
            );
            paginaint.dataValues.tiene_borrador = !!paginaint.borrador_existente;
            paginaint.dataValues.id_borrador = paginaint.borrador_existente?.fk_pag_nueva || null;

            // Asegurar que publicada esté disponible directamente
            if (paginaint.dataValues && paginaint.dataValues.publicada !== undefined) {
                paginaint.publicada = paginaint.dataValues.publicada;
            } else if (paginaint.publicada === undefined && paginaint.get) {
                paginaint.publicada = paginaint.get('publicada');
            }
        }
        for (const entrada of entradaslist) {
            entrada.idpagcy = jwt.sign(
                {
                    id_wb_pagina: entrada.id_wb_pagina,
                    idapp: idapp,
                    date_comp: new Date()
                },
                process.env.SECRET
            );

            // Asegurar que publicada esté disponible directamente
            if (entrada.dataValues && entrada.dataValues.publicada !== undefined) {
                entrada.publicada = entrada.dataValues.publicada;
            } else if (entrada.publicada === undefined && entrada.get) {
                entrada.publicada = entrada.get('publicada');
            }
        }
        for (const doc of regeneracionlist) {
            doc.iddoccy = jwt.sign(
                {
                    id_wb_doc: doc.id_wb_doc,
                    idapp: idapp,
                    date_comp: new Date()
                },
                process.env.SECRET
            );
        }
        //console.log(regeneracionlist);

        let paginainicialView = allowPrincipal ? paginainicial : [];
        let paginaslistView = allowInterior ? paginaslist : [];
        let entradaslistView = allowEntrada ? entradaslist : [];
        if (scopeDetail) {
            if (scopeDetail[1] && !scopeDetail[1].all && allowPrincipal) {
                const ids = idsFromScopeRule(scopeDetail[1]);
                paginainicialView = paginainicial.filter((p) => ids && ids.includes(Number(p.id_wb_pagina)));
            }
            if (scopeDetail[2] && !scopeDetail[2].all && allowInterior) {
                const ids = idsFromScopeRule(scopeDetail[2]);
                paginaslistView = paginaslist.filter((p) => ids && ids.includes(Number(p.id_wb_pagina)));
            }
            if (scopeDetail[5] && !scopeDetail[5].all && allowEntrada) {
                const ids = idsFromScopeRule(scopeDetail[5]);
                entradaslistView = entradaslist.filter((e) => ids && ids.includes(Number(e.id_wb_pagina)));
            }
        }

        const regeneracionlistView = allowRegeneracion ? regeneracionlist : [];

        res.render('../views/paginasList', {
            ...req.usdata,
            paginainicial: paginainicialView,
            paginaslist: paginaslistView,
            entradaslist: entradaslistView,
            regeneracionlist: regeneracionlistView,
            allowPrincipal: allowPrincipal,
            allowInterior: allowInterior,
            allowEntrada: allowEntrada,
            allowRegeneracion: allowRegeneracion,
            bimestres: bimestres,
            tags: tags,
            idcypher: cypheridapp,
            tieneDominio: tieneDominio,
            instanciaActualNombre: instanciaActualNombre,
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function paginaPruebas(req, res) {
    try {
        res.render('../views/pruebas', {
            dataapp: {
                app_legend: "Morena",
                app_favicon: "",
                nombre_pagina: "Pruebas de páginas",
            },
            datapagina: {
                nombre_pagina: "",
                contenido_alt: "",

            },
            classtop: "",
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function paginaTags(req, res) {
    try {
        const tokenTag = req.query.v;                 // el JWT del tag
        const pageRaw = req.query.page;
        let page = parseInt(pageRaw, 10);
        if (isNaN(page) || page < 1) page = 1;

        const per_page = 20;
        const offset = (page - 1) * per_page;   // ✅ ESTA ES LA FÓRMULA CORRECTA

        if (!tokenTag) throw new Error('Falta parámetro v');

        const decoded = await promisify(jwt.verify)(tokenTag, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición');
        const compareDates = utilFun.compareDates(decoded.date_comp);
        if (!compareDates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        const idtagdecoded = decoded.id_tag;
        // El JWT del tag puede incluir id_wb_pagina; lo usamos para mantener el contexto
        // de la instancia (fk_id_sysapp) y evitar mezclar entradas de distintas instancias.
        let idapp = decoded.idapp ?? null;
        if (!idapp && decoded.id_wb_pagina) {
            const paginaRef = await pagina.findOne({
                where: { id_wb_pagina: decoded.id_wb_pagina, vigente: true },
                attributes: ['fk_id_sysapp'],
                raw: true
            });
            idapp = paginaRef?.fk_id_sysapp ?? null;
        }

        // Relación tag → páginas
        const relTagPag = await paginaModel.rel_wb_tag_pagina.findAll({
            where: { fk_id_cat_tag: idtagdecoded, vigente: true },
            attributes: ['fk_id_wb_pagina', 'fk_id_cat_tag'],
            raw: true
        });

        if (!relTagPag || !relTagPag.length) {
            return res.render('publics/entradas', {
                dataapp: { app_legend: 'Morena', id_sysapp: idapp },
                datapagina: { nombre_pagina: 'Entradas' },
                classtop: '',
                objPagEntrada: [],
                paginador: '',
                total_reg: 0,
                pagina_actual: 1,
                total_pag: 0,
                tokenTag
            });
        }

        const idsPaginas = relTagPag.map(tag => tag.fk_id_wb_pagina);

        // Paginado: count + rows
        const { count: numrows, rows: pagEntrada } = await pagina.findAndCountAll({
            where: {
                id_wb_pagina: { [Op.in]: idsPaginas },
                vigente: true,
                ...(idapp ? { fk_id_sysapp: idapp } : {})
            },
            attributes: [
                'id_wb_pagina',
                'nombre_pagina',
                'contenido',
                'contenido_alt',
                'fk_id_file',
                'f_reg',
                'f_publicacion',
                'url_safe',
                'fk_id_sysapp'
            ],
            include: [{
                model: filesModel.filesMain,
                as: 'archivo',
                attributes: ['file_path']
            }],
            order: [
                [Sequelize.fn('COALESCE', Sequelize.col('f_publicacion'), Sequelize.col('f_reg')), 'DESC'],
            ],
            limit: per_page,
            offset: offset,
        });

        //console.log('page:', page, 'per_page:', per_page, 'offset:', offset, 'numrows:', numrows);

        if (!pagEntrada || !pagEntrada.length) {
            return res.render('publics/entradas', {
                dataapp: { app_legend: 'Morena', id_sysapp: idapp },
                datapagina: { nombre_pagina: 'Entradas' },
                classtop: '',
                objPagEntrada: [],
                paginador: '',
                total_reg: numrows || 0,
                pagina_actual: page,
                total_pag: Math.ceil((numrows || 0) / per_page),
                tokenTag
            });
        }

        const total_pages = Math.ceil(numrows / per_page);
        // Fallback si no se pudo resolver por decoded.id_wb_pagina.
        if (!idapp) {
            idapp = pagEntrada?.[0]?.fk_id_sysapp ?? null;
        }

        const objPagEntrada = pagEntrada.map(p => ({
            tag: idtagdecoded,
            nombre_pagina: p.nombre_pagina,
            contenido_alt: p.contenido_alt,
            contenido: p.contenido,
            file_path: p.archivo ? p.archivo.file_path : null,
            f_reg: p.f_publicacion || p.f_reg,
            f_publicacion: p.f_publicacion,
            url_safe: p.url_safe,
            fk_id_sysapp: p.fk_id_sysapp,
            idpagcy: jwt.sign(
                {
                    id_tag: idtagdecoded,
                    idapp: p.fk_id_sysapp,
                    id_wb_pagina: p.id_wb_pagina,
                    date_comp: new Date()
                },
                process.env.SECRET
            )
        }));

        const paginador = await paginate('entradasGoToPage', '', page, total_pages, 1);

        res.render('publics/entradas', {
            dataapp: { app_legend: 'Morena', id_sysapp: idapp },
            datapagina: { nombre_pagina: 'Entradas' },
            classtop: '',
            objPagEntrada,
            paginador,
            total_reg: numrows,
            pagina_actual: page,
            total_pag: total_pages,
            tokenTag
        });
    } catch (error) {
        console.error('[paginaTags] Error:', error);
        res.status(500).send('Error al cargar entradas.');
    }
}


async function paginaTagDetalle(req, res) {
    try {
        const tag_detalle = req.query.d;
        //// console.log(tag_detalle)

        const decoded = await promisify(jwt.verify)(tag_detalle, process.env.SECRET);
        if (!decoded) throw new Error('Alerta: Token JWT inválido');

        // Verifica la fecha de expiración (si aplica)
        let comparedates = utilFun.compareDates(decoded.date_comp);
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        const id_pag = decoded.id_wb_pagina;
        const id_tag = decoded.id_tag;
        const idapp = decoded.idapp ?? null;

        // // console.log('id_pag:', id_pag);
        // // console.log('id_tag:', id_tag);

        let relTagPag = await paginaModel.rel_wb_tag_pagina.findOne({
            where: {
                fk_id_wb_pagina: id_pag,
                fk_id_cat_tag: id_tag
            }
        });
        //// console.log('relTagPag:', relTagPag);

        if (!relTagPag) {
            res.status(404).json({ success: false, error: 1, message: 'Error, la entrada no existe.' });
            return;
        }

        let pagEntrada = await paginaModel.pagina.findOne({
            where: {
                id_wb_pagina: id_pag,
                fk_id_cat_type_pagina: 5,
                vigente: true,
                // publicada: true
            },
            attributes: [
                'fk_id_file',
                'nombre_pagina',
                'f_reg',
                'f_publicacion',
                'contenido_alt',
                'contenido',
            ],
            include: [{
                model: filesModel.filesMain,
                as: 'archivo',
                attributes: ['file_path']
            }]
        });
        //// console.log('pagEntrada:', JSON.stringify(pagEntrada));
        res.render('publics/entradas_detalle', {
            dataapp: { app_legend: "Morena", id_sysapp: idapp },
            datapagina: { nombre_pagina: "Detalle de la entrada" },
            classtop: "",
            objPagEntrada: pagEntrada
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}





// -----------------------------------------------------------//
// Persistencia de Regeneración
async function CreateRegeneracion(req, res) {
    try {
        // VALIDACIÓN
        let cy = req.body.cy;
        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let idapp = decoded.idapp;

        const token = req.cookies[process.env.APP_COOKIE_NAME];
        const usuario = jwt.verify(token, process.env.SECRET);
        const iduser = usuario.id_user;
        //console.log("Usuario ID:", iduser);

        if (await isPaginaTipoDeniedForEditor(req.usdata, idapp, TIPO_REGENERACION)) {
            return res.status(403).json({
                success: false,
                message: 'No tiene permiso para administrar la sección Regeneración en esta instancia.',
            });
        }

        let { nombre_doc, anio_doc, bimestre_doc, cont_alt_doc, id_file_imagen } = req.body;

        // Validar documento (PDF obligatorio) e imagen (selección del registro)
        let archivoDoc = req.files && req.files.length ? req.files.find(file => file.fieldname === 'archivo_doc') : null;

        if (!archivoDoc) {
            return res.status(400).json({
                success: false,
                message: 'Debe subir el documento (PDF).',
            });
        }
        if (!id_file_imagen || parseInt(id_file_imagen, 10) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Debe seleccionar una imagen del registro para la card.',
            });
        }

        // 1. Subir el documento (PDF)
        const docFilename = `cdn/websites/${idapp}/regeneracion/docs/${Date.now()}_${archivoDoc.originalname}`;
        const docBlob = bucket.file(docFilename);
        const docBlobStream = docBlob.createWriteStream();

        await new Promise((resolve, reject) => {
            docBlobStream.on("error", reject);
            docBlobStream.on("finish", resolve);
            docBlobStream.end(archivoDoc.buffer);
        });

        let newFileDoc = await filesModel.filesMain.create({
            file_name: archivoDoc.originalname,
            file_type: archivoDoc.mimetype,
            file_size: archivoDoc.size,
            file_path: docFilename,
            fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
        });

        // 2. Imagen de la card: usar la seleccionada del registro
        const fileExistente = await filesModel.filesMain.findOne({
            where: { id_file: parseInt(id_file_imagen, 10) }
        });
        if (!fileExistente) {
            return res.status(400).json({
                success: false,
                message: 'La imagen seleccionada no existe o no está disponible.',
            });
        }
        const newFileImg = fileExistente;

        // 3. Crear el documento principal en wb_docs (PDF)
        let newDoc = await paginaModel.documento.create({
            nombre: nombre_doc,
            contenido_alt: cont_alt_doc,
            fk_id_file: newFileDoc.id_file, // PDF del documento
            fk_id_user: iduser,
            vigente: true,
            f_reg: new Date(),
            fk_id_sysapp: idapp,
            f_publicacion: new Date()
        });

        // 4. Relacionar el documento con el tag de regeneración (13) y guardar año y bimestre
        await paginaModel.rel_wb_tag_doc.create({
            fk_id_cat_tag: 13, // Tag regeneración
            fk_id_wb_doc: newDoc.id_wb_doc,
            fk_id_user: iduser,
            anio: anio_doc,
            fk_id_cat_bimestre: bimestre_doc,
            vigente: true,
            f_reg: new Date()
        });

        // 5. Crear un SEGUNDO documento para la imagen
        let newDocImg = await paginaModel.documento.create({
            nombre: `Imagen - ${nombre_doc}`,
            contenido_alt: `Imagen para card de ${nombre_doc}`,
            fk_id_file: newFileImg.id_file, // Imagen de la card
            fk_id_cat_type_docs: 3, // Tipo documento imagen
            fk_id_user: iduser,
            vigente: true,
            f_reg: new Date(),
            fk_id_sysapp: idapp,
            f_publicacion: new Date()
        });

        // 6. Relacionar la imagen con el tag de imagen_regeneracion (14) y guardar año y bimestre
        await paginaModel.rel_wb_tag_doc.create({
            fk_id_cat_tag: 14, // Tag imagen_regeneracion
            fk_id_wb_doc: newDocImg.id_wb_doc,
            fk_id_user: iduser,
            anio: anio_doc,
            fk_id_cat_bimestre: bimestre_doc,
            vigente: true,
            f_reg: new Date()
        });

        // Solo generar HTML estático si la instancia tiene dominio asignado
        try {
            const hostingInst = await HostingModel.findOne({
                where: { fk_id_sysapp: idapp },
                attributes: ['fk_id_estatus_hosting'],
                raw: true
            });
            const tieneDominio = !!(hostingInst && hostingInst.fk_id_estatus_hosting === 2);
            if (tieneDominio) {
                const staticGenerator = require('../util/staticGenerator');
                const objapp = global.catalogos && global.catalogos.cat_apps_activas
                    ? global.catalogos.cat_apps_activas.find(a => a.id_sysapp === idapp)
                    : null;
                if (objapp) {
                    await staticGenerator.generateAndSaveStaticHTMLForRegeneracion(objapp);
                }
            }
        } catch (e) {
            console.error('Error generando HTML estático de regeneración:', e);
        }

        return res.status(200).json({
            success: true,
            message: 'Documento de regeneración creado exitosamente.',
            data: {
                id_wb_doc: newDoc.id_wb_doc,
                id_wb_doc_img: newDocImg.id_wb_doc
            }
        });

    } catch (error) {
        console.error("Error en CreateRegeneracion:", error);
        res.status(500).json({
            success: false,
            error: 1,
            message: 'Error al crear el documento de regeneración: ' + error.message
        });
    }
}

async function pagRegeneracionDetalle(req, res) {
    try {
        // Instancia: obligatoria por token en query "i" (JWT con idapp)
        let idapp = null;
        if (req.query.i) {
            try {
                const decoded = await promisify(jwt.verify)(req.query.i, process.env.SECRET);
                if (decoded && decoded.idapp) idapp = decoded.idapp;
            } catch (e) {
                console.error("Token de instancia inválido en /regeneracion", e.message);
            }
        }
        if (idapp == null) {
            return res.render('publics/regeneracion_detalle', {
                dataapp: { app_legend: "Morena Regeneración" },
                datapagina: { nombre_pagina: "Detalle de los periódicos de Regeneración" },
                classtop: "",
                regeneracionesPorAnio: {},
                anioActual: null,
                añosDisponibles: []
            });
        }

        // Relaciones tag 13 (regeneración) vigentes
        const todasRegeneraciones = await paginaModel.rel_wb_tag_doc.findAll({
            where: {
                fk_id_cat_tag: 13,
                vigente: true
            },
            attributes: ['id_rel_wb_tag_doc', 'fk_id_wb_doc', 'fk_id_cat_bimestre', 'f_reg', 'anio'],
            order: [['anio', 'DESC'], ['f_reg', 'DESC']],
            raw: true
        });
        const idsDocumentos = todasRegeneraciones.map(rel => rel.fk_id_wb_doc);

        // Documentos (PDFs) solo de esta instancia
        const documentos = await paginaModel.documento.findAll({
            where: {
                id_wb_doc: idsDocumentos.length ? idsDocumentos : [0],
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
        const idsDocInstancia = documentos.map(d => d.id_wb_doc);
        const todasRegeneracionesInstancia = todasRegeneraciones.filter(rel => idsDocInstancia.includes(rel.fk_id_wb_doc));

        // Años disponibles solo con datos de esta instancia
        const añosUnicos = [...new Set(todasRegeneracionesInstancia.map(r => r.anio).filter(Boolean))].sort((a, b) => (b - a));
        const añosFiltrados = añosUnicos;

        // Imágenes de card (incluir f_reg para emparejar por orden de creación)
        const relacionesImagenes = await paginaModel.rel_wb_tag_doc.findAll({
            where: {
                fk_id_cat_tag: 14,
                vigente: true
            },
            attributes: ['fk_id_wb_doc', 'fk_id_cat_bimestre', 'anio', 'f_reg'],
            order: [['f_reg', 'ASC']],
            raw: true
        });
        const idsImagenes = relacionesImagenes.map(rel => rel.fk_id_wb_doc);
        const imagenesDocs = await paginaModel.documento.findAll({
            where: {
                id_wb_doc: idsImagenes.length ? idsImagenes : [0],
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

        const regeneracionesPorAnio = {};
        todasRegeneracionesInstancia.forEach(rel => {
            const anio = rel.anio;
            if (!regeneracionesPorAnio[anio]) regeneracionesPorAnio[anio] = [];
            const doc = documentos.find(d => d.id_wb_doc === rel.fk_id_wb_doc);
            const tPdf = new Date(rel.f_reg).getTime();
            const candidatas = relacionesImagenes
                .filter(img => img.fk_id_cat_bimestre === rel.fk_id_cat_bimestre && img.anio === anio)
                .map(img => ({ ...img, t: new Date(img.f_reg).getTime() }));
            const imgRel = candidatas
                .filter(c => c.t >= tPdf)
                .sort((a, b) => a.t - b.t)[0]
                || candidatas.sort((a, b) => b.t - a.t)[0];
            const imgDoc = imgRel ? imagenesDocs.find(imgD => imgD.id_wb_doc === imgRel.fk_id_wb_doc) : null;
            if (doc) {
                regeneracionesPorAnio[anio].push({
                    nombre_doc: doc.nombre,
                    archivoDoc: doc.archivodoc,
                    imagenCard: imgDoc?.archivodoc,
                    bimestre: rel.fk_id_cat_bimestre
                });
            }
        });

        let anioActivo = añosFiltrados.length > 0 ? añosFiltrados[0] : null;
        if (req.query.v) {
            try {
                const decoded = jwt.verify(req.query.v, process.env.SECRET);
                if (utilFun.compareDates(decoded.date_comp) && decoded.anio != null) {
                    anioActivo = decoded.anio;
                }
            } catch (error) {
                console.error("Token de año inválido, usando año por defecto", error);
            }
        }

        res.render('publics/regeneracion_detalle', {
            dataapp: { app_legend: "Morena Regeneración" },
            datapagina: { nombre_pagina: "Detalle de los periódicos de Regeneración" },
            classtop: "",
            regeneracionesPorAnio,
            anioActual: anioActivo,
            añosDisponibles: añosFiltrados
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function EditRegeneracion(req, res) {
    try {
        const { token, nombre_doc, anio_doc, bimestre_doc, cont_alt_doc } = req.body;

        // Verificar y decodificar el token
        const decoded = await promisify(jwt.verify)(token, process.env.SECRET);
        const id_wb_doc = decoded.id_wb_doc;
        const idapp = decoded.idapp;

        const tokenUser = req.cookies[process.env.APP_COOKIE_NAME];
        const usuario = jwt.verify(tokenUser, process.env.SECRET);
        const iduser = usuario.id_user;

        if (await isPaginaTipoDeniedForEditor(req.usdata, idapp, TIPO_REGENERACION)) {
            return res.status(403).json({
                success: false,
                message: 'No tiene permiso para administrar la sección Regeneración en esta instancia.',
            });
        }

        // Buscar el documento principal
        const documento = await paginaModel.documento.findOne({
            where: {
                id_wb_doc: id_wb_doc,
                fk_id_sysapp: idapp,
                vigente: true
            }
        });

        if (!documento) {
            return res.status(404).json({
                success: false,
                message: 'Documento no encontrado.'
            });
        }

        // Buscar la relación de regeneración (tag 13)
        const relacionRegeneracion = await paginaModel.rel_wb_tag_doc.findOne({
            where: {
                fk_id_wb_doc: id_wb_doc,
                fk_id_cat_tag: 13,
                vigente: true
            }
        });

        if (!relacionRegeneracion) {
            return res.status(404).json({
                success: false,
                message: 'Relación de regeneración no encontrada.'
            });
        }

        // Buscar la imagen que pertenece a ESTA regeneración (mismo año/bimestre, f_reg justo después del PDF)
        const relacionesImagenAnioBimestre = await paginaModel.rel_wb_tag_doc.findAll({
            where: {
                fk_id_cat_tag: 14,
                anio: relacionRegeneracion.anio,
                fk_id_cat_bimestre: relacionRegeneracion.fk_id_cat_bimestre,
                vigente: true
            },
            order: [['f_reg', 'ASC']],
            raw: true
        });
        const tPdf = new Date(relacionRegeneracion.f_reg).getTime();
        const relacionImagen = relacionesImagenAnioBimestre.length === 0 ? null
            : relacionesImagenAnioBimestre.find(r => new Date(r.f_reg).getTime() >= tPdf)
            || relacionesImagenAnioBimestre[relacionesImagenAnioBimestre.length - 1];

        let imagenDoc = null;
        if (relacionImagen) {
            imagenDoc = await paginaModel.documento.findOne({
                where: {
                    id_wb_doc: relacionImagen.fk_id_wb_doc,
                    vigente: true
                }
            });
        }

        // Iniciar transacción
        const transaction = await dbConection.transaction();

        try {
            // 1. Actualizar el documento principal
            await paginaModel.documento.update(
                {
                    nombre: nombre_doc,
                    contenido_alt: cont_alt_doc
                },
                {
                    where: { id_wb_doc: id_wb_doc },
                    transaction
                }
            );

            // 2. Actualizar la relación de regeneración (año y bimestre)
            await paginaModel.rel_wb_tag_doc.update(
                {
                    anio: anio_doc,
                    fk_id_cat_bimestre: bimestre_doc
                },
                {
                    where: {
                        fk_id_wb_doc: id_wb_doc,
                        fk_id_cat_tag: 13
                    },
                    transaction
                }
            );

            // 3. Si existe la imagen relacionada, actualizar su relación también
            if (relacionImagen && imagenDoc) {
                await paginaModel.rel_wb_tag_doc.update(
                    {
                        anio: anio_doc,
                        fk_id_cat_bimestre: bimestre_doc
                    },
                    {
                        where: {
                            fk_id_wb_doc: relacionImagen.fk_id_wb_doc,
                            fk_id_cat_tag: 14
                        },
                        transaction
                    }
                );

                // Actualizar el nombre de la imagen si es necesario
                await paginaModel.documento.update(
                    {
                        nombre: `Imagen - ${nombre_doc}`,
                        contenido_alt: `Imagen para card de ${nombre_doc}`
                    },
                    {
                        where: { id_wb_doc: relacionImagen.fk_id_wb_doc },
                        transaction
                    }
                );
            }

            // 4. Manejar archivos si se suben nuevos
            let archivoDoc = req.files.find(file => file.fieldname === 'archivo_doc');
            let archivoImg = req.files.find(file => file.fieldname === 'imagen_card');

            // Actualizar documento PDF si se sube uno nuevo
            if (archivoDoc) {
                // Subir nuevo archivo
                const docFilename = `cdn/websites/${idapp}/regeneracion/docs/${Date.now()}_${archivoDoc.originalname}`;
                const docBlob = bucket.file(docFilename);
                const docBlobStream = docBlob.createWriteStream();

                await new Promise((resolve, reject) => {
                    docBlobStream.on("error", reject);
                    docBlobStream.on("finish", resolve);
                    docBlobStream.end(archivoDoc.buffer);
                });

                // CORRECCIÓN: Crear nuevo registro de archivo SIN transaction primero
                let newFileDoc = await filesModel.filesMain.create({
                    file_name: archivoDoc.originalname,
                    file_type: archivoDoc.mimetype,
                    file_size: archivoDoc.size,
                    file_path: docFilename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                });
                // Nota: Si necesitas transaction aquí, verifica la estructura del modelo

                // Actualizar referencia al archivo en el documento
                await paginaModel.documento.update(
                    { fk_id_file: newFileDoc.id_file },
                    { where: { id_wb_doc: id_wb_doc }, transaction }
                );
            }

            // Actualizar imagen si se sube una nueva
            if (archivoImg && imagenDoc) {
                // Subir nueva imagen
                const imgFilename = `cdn/websites/${idapp}/regeneracion/imgs/${Date.now()}_${archivoImg.originalname}`;
                const imgBlob = bucket.file(imgFilename);
                const imgBlobStream = imgBlob.createWriteStream();

                await new Promise((resolve, reject) => {
                    imgBlobStream.on("error", reject);
                    imgBlobStream.on("finish", resolve);
                    imgBlobStream.end(archivoImg.buffer);
                });

                // CORRECCIÓN: Crear nuevo registro de archivo SIN transaction primero
                let newFileImg = await filesModel.filesMain.create({
                    file_name: archivoImg.originalname,
                    file_type: archivoImg.mimetype,
                    file_size: archivoImg.size,
                    file_path: imgFilename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                });

                // Actualizar referencia al archivo en el documento de imagen
                await paginaModel.documento.update(
                    { fk_id_file: newFileImg.id_file },
                    { where: { id_wb_doc: imagenDoc.id_wb_doc }, transaction }
                );
            }

            // Confirmar transacción
            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: 'Documento de regeneración actualizado correctamente.'
            });

        } catch (error) {
            // Revertir transacción en caso de error
            await transaction.rollback();
            throw error;
        }

        // Solo generar HTML estático si la instancia tiene dominio asignado
        try {
            const hostingInst = await HostingModel.findOne({
                where: { fk_id_sysapp: idapp },
                attributes: ['fk_id_estatus_hosting'],
                raw: true
            });
            const tieneDominio = !!(hostingInst && hostingInst.fk_id_estatus_hosting === 2);
            if (tieneDominio) {
                const staticGenerator = require('../util/staticGenerator');
                const objapp = global.catalogos && global.catalogos.cat_apps_activas
                    ? global.catalogos.cat_apps_activas.find(a => a.id_sysapp === idapp)
                    : null;
                if (objapp) {
                    await staticGenerator.generateAndSaveStaticHTMLForRegeneracion(objapp);
                }
            }
        } catch (e) {
            console.error('Error generando HTML estático de regeneración:', e);
        }

    } catch (error) {
        console.error("Error en EditRegeneracion:", error);
        res.status(500).json({
            success: false,
            message: 'Error al actualizar el documento de regeneración: ' + error.message
        });
    }
}

async function DeleteRegeneracion(req, res) {
    try {
        const { token } = req.body;

        // Verificar y decodificar el token
        const decoded = await promisify(jwt.verify)(token, process.env.SECRET);
        const id_wb_doc = decoded.id_wb_doc;
        const idapp = decoded.idapp;

        if (await isPaginaTipoDeniedForEditor(req.usdata, idapp, TIPO_REGENERACION)) {
            return res.status(403).json({
                success: false,
                message: 'No tiene permiso para administrar la sección Regeneración en esta instancia.',
            });
        }

        // Buscar el documento principal (PDF)
        const documento = await paginaModel.documento.findOne({
            where: {
                id_wb_doc: id_wb_doc,
                fk_id_sysapp: idapp,
                vigente: true
            }
        });

        if (!documento) {
            return res.status(404).json({
                success: false,
                message: 'Documento no encontrado.'
            });
        }

        // Buscar la relación con tag 13 (regeneración)
        const relacionRegeneracion = await paginaModel.rel_wb_tag_doc.findOne({
            where: {
                fk_id_wb_doc: id_wb_doc,
                fk_id_cat_tag: 13,
                vigente: true
            }
        });

        if (!relacionRegeneracion) {
            return res.status(404).json({
                success: false,
                message: 'Relación de regeneración no encontrada.'
            });
        }

        // Buscar la imagen que pertenece a ESTA regeneración (mismo año/bimestre, f_reg justo después del PDF)
        const relacionesImagenAnioBimestre = await paginaModel.rel_wb_tag_doc.findAll({
            where: {
                fk_id_cat_tag: 14,
                anio: relacionRegeneracion.anio,
                fk_id_cat_bimestre: relacionRegeneracion.fk_id_cat_bimestre,
                vigente: true
            },
            order: [['f_reg', 'ASC']],
            raw: true
        });
        const tPdfDel = new Date(relacionRegeneracion.f_reg).getTime();
        const relacionImagen = relacionesImagenAnioBimestre.length === 0 ? null
            : relacionesImagenAnioBimestre.find(r => new Date(r.f_reg).getTime() >= tPdfDel)
            || relacionesImagenAnioBimestre[relacionesImagenAnioBimestre.length - 1];

        // Iniciar transacción para asegurar consistencia
        const transaction = await dbConection.transaction();

        try {
            // 1. Marcar como no vigente el documento principal (PDF)
            await paginaModel.documento.update(
                {
                    vigente: false,
                    f_no_vigente: new Date()
                },
                {
                    where: { id_wb_doc: id_wb_doc },
                    transaction
                }
            );

            // 2. Marcar como no vigente la relación del documento principal
            await paginaModel.rel_wb_tag_doc.update(
                {
                    vigente: false,
                    f_no_vigente: new Date()
                },
                {
                    where: {
                        fk_id_wb_doc: id_wb_doc,
                        fk_id_cat_tag: 13
                    },
                    transaction
                }
            );

            // 3. Si existe la imagen relacionada, marcarla como no vigente también
            if (relacionImagen) {
                await paginaModel.documento.update(
                    {
                        vigente: false,
                        f_no_vigente: new Date()
                    },
                    {
                        where: { id_wb_doc: relacionImagen.fk_id_wb_doc },
                        transaction
                    }
                );

                await paginaModel.rel_wb_tag_doc.update(
                    {
                        vigente: false,
                        f_no_vigente: new Date()
                    },
                    {
                        where: {
                            fk_id_wb_doc: relacionImagen.fk_id_wb_doc,
                            fk_id_cat_tag: 14
                        },
                        transaction
                    }
                );
            }

            // Confirmar transacción
            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: 'Documento de regeneración eliminado correctamente.'
            });

        } catch (error) {
            // Revertir transacción en caso de error
            await transaction.rollback();
            throw error;
        }

        // Solo generar HTML estático si la instancia tiene dominio asignado
        try {
            const hostingInst = await HostingModel.findOne({
                where: { fk_id_sysapp: idapp },
                attributes: ['fk_id_estatus_hosting'],
                raw: true
            });
            const tieneDominio = !!(hostingInst && hostingInst.fk_id_estatus_hosting === 2);
            if (tieneDominio) {
                const staticGenerator = require('../util/staticGenerator');
                const objapp = global.catalogos && global.catalogos.cat_apps_activas
                    ? global.catalogos.cat_apps_activas.find(a => a.id_sysapp === idapp)
                    : null;
                if (objapp) {
                    await staticGenerator.generateAndSaveStaticHTMLForRegeneracion(objapp);
                }
            }
        } catch (e) {
            console.error('Error generando HTML estático de regeneración:', e);
        }

    } catch (error) {
        console.error("Error en DeleteRegeneracion:", error);
        res.status(500).json({
            success: false,
            message: 'Error al eliminar el documento de regeneración: ' + error.message
        });
    }
}

async function GetRegeneracion(req, res) {
    try {
        const { token } = req.body;

        // Verificar y decodificar el token
        const decoded = await promisify(jwt.verify)(token, process.env.SECRET);
        const id_wb_doc = decoded.id_wb_doc;
        const idapp = decoded.idapp;

        if (await isPaginaTipoDeniedForEditor(req.usdata, idapp, TIPO_REGENERACION)) {
            return res.status(403).json({
                success: false,
                message: 'No tiene permiso para administrar la sección Regeneración en esta instancia.',
            });
        }

        // Buscar el documento principal (PDF) con sus relaciones
        const documento = await paginaModel.documento.findOne({
            where: {
                id_wb_doc: id_wb_doc,
                fk_id_sysapp: idapp,
                vigente: true
            },
            include: [
                {
                    model: filesModel.filesMain,
                    as: 'archivodoc',
                    attributes: ['file_path', 'file_name']
                },
                {
                    model: paginaModel.rel_wb_tag_doc,
                    as: 'tag_relations',
                    where: {
                        fk_id_cat_tag: 13,
                        vigente: true
                    },
                    required: false
                }
            ]
        });

        if (!documento) {
            return res.status(404).json({
                success: false,
                message: 'Documento no encontrado.'
            });
        }

        // Obtener la relación de regeneración (tag 13)
        const relacionRegeneracion = documento.tag_relations && documento.tag_relations.length > 0 ? documento.tag_relations[0] : null;

        if (!relacionRegeneracion) {
            return res.status(404).json({
                success: false,
                message: 'Relación de regeneración no encontrada.'
            });
        }

        // Buscar la imagen que pertenece a ESTA regeneración (mismo año/bimestre, f_reg justo después del PDF)
        const relacionesImagenGet = await paginaModel.rel_wb_tag_doc.findAll({
            where: {
                fk_id_cat_tag: 14,
                anio: relacionRegeneracion.anio,
                fk_id_cat_bimestre: relacionRegeneracion.fk_id_cat_bimestre,
                vigente: true
            },
            order: [['f_reg', 'ASC']],
            raw: true
        });
        const tPdfGet = new Date(relacionRegeneracion.f_reg).getTime();
        const relacionImagen = relacionesImagenGet.length === 0 ? null
            : relacionesImagenGet.find(r => new Date(r.f_reg).getTime() >= tPdfGet)
            || relacionesImagenGet[relacionesImagenGet.length - 1];

        let imagenDoc = null;
        if (relacionImagen) {
            imagenDoc = await paginaModel.documento.findOne({
                where: {
                    id_wb_doc: relacionImagen.fk_id_wb_doc,
                    vigente: true
                },
                include: [{
                    model: filesModel.filesMain,
                    as: 'archivodoc',
                    attributes: ['file_path', 'file_name']
                }]
            });
        }

        // OBTENER LOS BIMESTRES DEL CATÁLOGO
        const bimestres = await paginaModel.cat_bimestres.findAll({
            where: {
                vigente: true,
            },
            order: [
                ['num_bimestre', 'asc']
            ]
        });

        // Estructurar los datos a enviar
        const datosRegeneracion = {
            id_wb_doc: documento.id_wb_doc,
            nombre_doc: documento.nombre,
            contenido_alt: documento.contenido_alt,
            anio_doc: relacionRegeneracion.anio,
            bimestre_doc: relacionRegeneracion.fk_id_cat_bimestre, // Este es el ID del bimestre seleccionado
            archivo_doc: documento.archivodoc ? {
                file_path: documento.archivodoc.file_path,
                file_name: documento.archivodoc.file_name
            } : null,
            imagen_card: imagenDoc && imagenDoc.archivodoc ? {
                file_path: imagenDoc.archivodoc.file_path,
                file_name: imagenDoc.archivodoc.file_name
            } : null,
            // Agregar los bimestres a la respuesta
            bimestres: bimestres.map(bimestre => ({
                id: bimestre.id_cat_bimestres,
                nombre: bimestre.bimestre,
                numero: bimestre.num_bimestre
            }))
        };

        return res.status(200).json({
            success: true,
            data: datosRegeneracion
        });

    } catch (error) {
        console.error("Error en GetRegeneracion:", error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener el documento de regeneración: ' + error.message
        });
    }
}
//------------------------------------------------------------//








//-----------------------------------------------------------//
async function CreatePag(req, res) {
    try {
        let cy = req.body.cy;
        let tipo_duplicado = parseInt(req.body.tipo_duplicado);

        // VALIDACIÓN
        let cyphval = req.body.cyphval;
        const decoded = await promisify(jwt.verify)(cyphval, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let idapp = decoded.idapp;

        const token = req.cookies[process.env.APP_COOKIE_NAME];
        const usuario = jwt.verify(token, process.env.SECRET);
        const id_user = usuario.id_user;

        // BÁSICOS
        let errores = [];
        // nombre
        let idpag = req.body.idpag;
        // // console.log(idpag);

        let namepag = req.body.namepag;
        if (namepag === '') {
            errores.push('El nombre no puede estar vacío');
        }

        // tipo de página
        let type = parseInt(req.body.tipopag);

        const scopeCreate = await getEditorPaginaScopeDetail(id_user, idapp);
        if (scopeCreate && !scopeCreate[type]) {
            return res.status(403).json({
                success: false,
                error: 1,
                message: 'No tiene permiso para crear o gestionar este tipo de página en esta instancia.',
            });
        }
        if (scopeCreate && scopeCreate[type] && !scopeCreate[type].all) {
            return res.status(403).json({
                success: false,
                error: 1,
                message:
                    'Solo tiene permiso sobre ciertas páginas de este tipo; no puede crear páginas nuevas de este tipo.',
            });
        }

        // url
        let url = req.body.url;
        // console.log("URL original: "+url);

        url = url.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        url = url.toLowerCase();
        url = url.replace(/\s+/g, '-');
        url = url.replace(/[^a-z0-9\-]/g, '');
        url = url.substring(0, 50);
        url = url.replace(/-+$/, '');
        url = encodeURIComponent(url);
        // console.log("URL safe: "+url);

        if (url === '' && type !== 1) {
            errores.push('La URL no puede estar vacía');
        } else if (type === 1 && req.body.url !== '/') {
            errores.push('La URL es incorrecta para una página inicial');
        } else if (type === 1) {
            url = "/";
        } else {
            const whereUrl = {
                fk_id_sysapp: idapp,
                url_safe: url,
                vigente: true,
            };
            if (parseInt(idpag) > 0) {
                whereUrl.id_wb_pagina = { [Op.ne]: idpag };
            }
            const pags_count = await paginaModel.pagina.count({
                where: whereUrl
            });
            if (pags_count > 0) {
                errores.push('La URL ya existe');
            }
        }

        // contenido alt
        let cont_alt = req.body.cont_alt;
        if (cont_alt === '') {
            errores.push('Escriba una breve descripción de la página, ayuda a los navegadores a encontrarla');
        }

        // ============================================================
        // DUPLICAR (tipo_duplicado=2): duplicar contenido real de página origen
        // Evita crear una página "vacía" que pueda traer contenido default.
        // ============================================================
        const idpagIntEarly = parseInt(idpag, 10);
        if (idpagIntEarly === 0 && tipo_duplicado === 2 && cy) {
            if (errores.length > 0) {
                let htmlerro = '<ul>';
                errores.forEach(error => { htmlerro += `<li>${error}</li>`; });
                htmlerro += '</ul>';
                let erroreshtml = '<p>Por favor valida estos datos</p>' + htmlerro;
                return res.status(200).json({ success: false, error: 1, message: erroreshtml });
            }

            // Duplicar estructura y contenido, pero regresando como objeto (sin crear "borrador" tipo 1)
            const prevTipo = req.body.tipo_duplicado;
            const prevReturnOnly = req.body.returnOnly;
            req.body.tipo_duplicado = 2;
            req.body.returnOnly = true;
            // Para este modo, `duplicarPagina` requiere saber que debe CREAR la nueva página
            // (no usar id_pag_nueva). Lo logramos limpiando id_pag_nueva si viniera.
            const prevIdNueva = req.body.id_pag_nueva;
            delete req.body.id_pag_nueva;
            const dup = await duplicarPagina(req, res);
            req.body.tipo_duplicado = prevTipo;
            req.body.returnOnly = prevReturnOnly;
            if (prevIdNueva != null) req.body.id_pag_nueva = prevIdNueva;

            if (!dup || !dup.success || !dup.cy) {
                return res.status(500).json({ success: false, error: 1, message: 'Error al duplicar la página' });
            }

            // Actualizar campos básicos de la copia con el formulario
            const decodedNew = await promisify(jwt.verify)(dup.cy, process.env.SECRET);
            const newId = decodedNew && decodedNew.id_wb_pagina ? decodedNew.id_wb_pagina : null;
            if (!newId) {
                return res.status(500).json({ success: false, error: 1, message: 'No se pudo resolver la página duplicada' });
            }

            // Asegurar que la relación en rel_wb_pag_borrador quede como "duplicado" (2) y no como "edición" (1)
            // (esto también repara copias hechas durante la ventana en que se guardaron como tipo 1).
            try {
                const decodedOrigen = await promisify(jwt.verify)(cy, process.env.SECRET);
                const idOrigen = decodedOrigen && decodedOrigen.id_wb_pagina ? decodedOrigen.id_wb_pagina : null;
                if (idOrigen) {
                    await paginaModel.rel_wb_pag_borrador.update(
                        { fk_id_cat_pag_tipo_borrador: 2, vigente: true },
                        {
                            where: {
                                fk_pag_origen: idOrigen,
                                fk_pag_nueva: newId,
                                vigente: true
                            }
                        }
                    );
                }
            } catch (eRel) {
                console.warn('[CreatePag duplicar] No se pudo normalizar rel_wb_pag_borrador:', eRel.message);
            }

            const f_pub_dup = req.body.f_pub ? new Date(req.body.f_pub) : new Date();
            await paginaModel.pagina.update(
                {
                    nombre_pagina: namepag,
                    contenido_alt: cont_alt,
                    url_safe: url,
                    publicada: false,
                    f_publicacion: f_pub_dup,
                    fk_id_user: id_user
                },
                { where: { id_wb_pagina: newId, fk_id_sysapp: idapp } }
            );

            return res.status(200).json({ success: true, message: 'Página duplicada con éxito', pag: dup.cy });
        }

        // fecha de publicación (en edición se permiten fechas pasadas)
        let f_pub = new Date(req.body.f_pub)
        const idpagInt = parseInt(idpag);
        const typeInt = parseInt(type, 10);
        if (Number.isNaN(f_pub.getTime())) {
            errores.push('La fecha de publicación no es válida');
        } else if (idpagInt === 0 && typeInt !== 5) {
            const hoy = new Date();
            const semanaFutura = new Date();
            semanaFutura.setDate(hoy.getDate() + 7);
            const fechaHoy = hoy.toISOString().split('T')[0];
            const fechaSemanaFutura = semanaFutura.toISOString().split('T')[0];
            if (f_pub < fechaHoy || f_pub > fechaSemanaFutura) {
                errores.push('La fecha no puede ser menor a hoy, ni mayor a una semana de la fecha actual');
            }
        }

        let cont_full = '';
        let tipo_tag = 0;
        if (parseInt(idpag) === 0) {
            //Entradas
            if (type === 5) {
                cont_full = req.body.cont_full;
                if (cont_full === '') {
                    errores.push('El contenido de la entrada no debe ir vacío');
                }
                tipo_tag = parseInt(req.body.tipo_tag);
                if (tipo_tag === 0) {
                    errores.push('Seleccione un tipo de entrada');
                }
            }
            //Pags secundarias y de entrada
            if (type === 2 || type === 5) {
                // TODO hacer una opción de que sea opcional la imagen en esos casos que se ponga una default
                if (req.file && errores.length === 0) {
                    let filename = 'cdn/websites/' + idapp + '/' + req.file.originalname;
                    const blob = bucket.file(filename);
                    const blobStream = blob.createWriteStream();

                    blobStream.on("finish", () => {
                        filesModel.filesMain.create({
                            file_name: req.file.originalname,
                            file_type: req.file.mimetype,
                            file_size: req.file.size,
                            file_path: filename,
                            fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                        }).then(fileCreado => {
                            const idFile = fileCreado.id_file;
                            paginaModel.pagina.create({
                                nombre_pagina: namepag,
                                contenido_alt: cont_alt,
                                contenido: cont_full,
                                fk_id_file: idFile,
                                fk_id_cat_type_pagina: type,
                                fk_id_user: id_user,
                                vigente: true,
                                f_reg: new Date(),
                                f_no_vigente: null,
                                url_safe: url,
                                fk_id_sysapp: idapp,
                                publicada: false,
                                f_publicacion: f_pub
                            }).then(paginaCreada => {
                                if (tipo_tag !== 0) {
                                    paginaModel.rel_wb_tag_pagina.create({
                                        fk_id_cat_tag: tipo_tag,
                                        fk_id_wb_pagina: paginaCreada.id_wb_pagina,
                                        fk_id_user: id_user,
                                        vigente: true
                                    }).then(reltagcreado => {
                                        //// console.log('página creada con archivo y tag! : '+paginaCreada.id_wb_pagina+' archivo: '+idFile+ ' rel tag:'+reltagcreado.id_rel_wb_tag_pagina);
                                        const idpagcy = jwt.sign(
                                            {
                                                idapp: idapp,
                                                id_wb_pagina: paginaCreada.id_wb_pagina,
                                                date_comp: new Date()
                                            },
                                            process.env.SECRET
                                        );
                                        dispararBitacoraPaginaAlta(id_user, idapp, paginaCreada.id_wb_pagina, type, req);
                                        res.status(200).json({ success: true, message: 'Página guardada con éxito', pag: idpagcy });
                                    }).catch(error => {
                                        console.error(error)
                                    });
                                } else {
                                    //// console.log('página creada con archivo! : '+paginaCreada.id_wb_pagina+' archivo: '+idFile);
                                    if (tipo_duplicado === 2 && cy) {
                                        req.body.id_pag_nueva = paginaCreada.id_wb_pagina;
                                        duplicarPagina(req, res).then(dupPag => {
                                            //// console.log(dupPag);
                                            const idpagcy = jwt.sign(
                                                {
                                                    idapp: idapp,
                                                    id_wb_pagina: paginaCreada.id_wb_pagina,
                                                    date_comp: new Date()
                                                },
                                                process.env.SECRET
                                            );
                                            if (dupPag.success) {
                                                dispararBitacoraPaginaAlta(id_user, idapp, paginaCreada.id_wb_pagina, type, req);
                                                res.status(200).json({ success: true, message: 'Página guardada con éxito duppagggggg', pag: idpagcy });
                                            }
                                        }).catch(error => {
                                            throw new Error(error);
                                            console.error(error)
                                        });

                                    } else {
                                        if (type === 2) {
                                            const idPag = paginaCreada.id_wb_pagina;
                                            paginaModel.seccion.create({
                                                fk_id_wb_pagina: idPag,
                                                fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                                                wb_margin: [10, 10, 10, 10],
                                                wb_padding: [10, 10, 10, 10],
                                                fk_id_cat_wb_width: 1,
                                                wb_num_col: 1,
                                                vigente: true,
                                                f_reg: new Date(),
                                                f_no_vigente: null,
                                                orden_visible: 1
                                            }).then(newSecc => {

                                                paginaModel.columna.create({
                                                    fk_id_wb_pag_seccion: newSecc.id_wb_pag_seccion,
                                                    fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                                                    wb_padding: [10, 10, 10, 10],
                                                    orden_visible: 1,
                                                    vigente: true,
                                                    f_reg: new Date()
                                                });
                                            }).then(colCreada => {
                                                // console.log('Columna creada:', colCreada.id_wb_pag_columna);
                                            }).catch(error => {
                                                console.error('Error al crear sección/columna para type 2:', error);
                                            });
                                        }
                                        const idpagcy = jwt.sign(
                                            {
                                                idapp: idapp,
                                                id_wb_pagina: paginaCreada.id_wb_pagina,
                                                date_comp: new Date()
                                            },
                                            process.env.SECRET
                                        );

                                        dispararBitacoraPaginaAlta(id_user, idapp, paginaCreada.id_wb_pagina, type, req);
                                        res.status(200).json({ success: true, message: 'Página guardada con éxito', pag: idpagcy });
                                    }

                                }
                            }).catch(error => {
                                console.error(error)
                            });
                        }).catch(error => {
                            console.error('1 Error al insertar el archivo o la página en la base de datos:', error);
                            res.status(500).json({ success: false, error: 1, message: '1 Error al insertar el archivo en la base de datos' });
                        });

                    });

                    blobStream.on('error', (err) => {
                        console.error('Error al cargar el archivo:', err);
                        res.status(500).json({ success: false, error: 1, message: 'Error al cargar el archivo' });
                    });

                    blobStream.end(req.file.buffer);
                } else if (errores.length === 0) {
                    // Página interior (type 2): la imagen NO es obligatoria (crear sin imagen)
                    if (type === 2) {
                        paginaModel.pagina.create({
                            nombre_pagina: namepag,
                            contenido_alt: cont_alt,
                            contenido: null,
                            fk_id_file: null,
                            fk_id_cat_type_pagina: type,
                            fk_id_user: id_user,
                            vigente: true,
                            f_reg: new Date(),
                            f_no_vigente: null,
                            url_safe: url,
                            fk_id_sysapp: idapp,
                            publicada: false,
                            f_publicacion: f_pub
                        }).then(paginaCreada => {
                            // Estructura base para páginas interiores
                            const idPag = paginaCreada.id_wb_pagina;
                            paginaModel.seccion.create({
                                fk_id_wb_pagina: idPag,
                                fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                                wb_margin: [10, 10, 10, 10],
                                wb_padding: [10, 10, 10, 10],
                                fk_id_cat_wb_width: 1,
                                wb_num_col: 1,
                                vigente: true,
                                f_reg: new Date(),
                                f_no_vigente: null,
                                orden_visible: 1
                            }).then(newSecc => {
                                return paginaModel.columna.create({
                                    fk_id_wb_pag_seccion: newSecc.id_wb_pag_seccion,
                                    fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                                    wb_padding: [10, 10, 10, 10],
                                    orden_visible: 1,
                                    vigente: true,
                                    f_reg: new Date()
                                });
                            }).catch(error => {
                                console.error('Error al crear sección/columna para type 2:', error);
                            }).finally(() => {
                                const idpagcy = jwt.sign(
                                    { idapp: idapp, id_wb_pagina: paginaCreada.id_wb_pagina, date_comp: new Date() },
                                    process.env.SECRET
                                );

                                // Si el flujo es duplicar (tipo_duplicado 2), duplicarPagina copiará el contenido encima de la base
                                if (tipo_duplicado === 2 && cy) {
                                    req.body.id_pag_nueva = paginaCreada.id_wb_pagina;
                                    duplicarPagina(req, res).then(dupPag => {
                                        if (dupPag && dupPag.success) {
                                            dispararBitacoraPaginaAlta(id_user, idapp, paginaCreada.id_wb_pagina, type, req);
                                            return res.status(200).json({ success: true, message: 'Página duplicada con éxito', pag: idpagcy });
                                        }
                                        return res.status(200).json({ success: false, message: dupPag?.message || 'Error al duplicar' });
                                    }).catch(error => {
                                        console.error('Error en duplicarPagina:', error);
                                        return res.status(500).json({ success: false, error: 1, message: 'Error al duplicar la página' });
                                    });
                                } else {
                                    dispararBitacoraPaginaAlta(id_user, idapp, paginaCreada.id_wb_pagina, type, req);
                                    return res.status(200).json({ success: true, message: 'Página guardada con éxito', pag: idpagcy });
                                }
                            });
                        }).catch(error => {
                            console.error('Error al crear página interior sin imagen:', error);
                            res.status(500).json({ success: false, error: 1, message: 'Error al crear la página' });
                        });
                    } else {
                        errores.push('No se subió imagen para la página interior');
                    }
                }
            }

            //Pág principal
            if (errores.length > 0) {
                let htmlerro = '<ul>';
                errores.forEach(error => {
                    htmlerro += `<li>${error}</li>`;
                });
                htmlerro += '</ul>';
                let erroreshtml = '<p>Por favor valida estos datos</p>' + htmlerro;
                res.status(200).json({ success: false, error: 1, message: erroreshtml });
            } else if (type === 1 && errores.length === 0) {
                paginaModel.pagina.create({
                    nombre_pagina: namepag,
                    contenido_alt: cont_alt,
                    contenido: null,
                    fk_id_file: null,
                    fk_id_cat_type_pagina: type,
                    fk_id_user: id_user,
                    vigente: true,
                    f_reg: new Date(),
                    f_no_vigente: null,
                    url_safe: url,
                    fk_id_sysapp: idapp,
                    publicada: false,
                    f_publicacion: f_pub
                }).then(paginaCreada => {
                    const idPag = paginaCreada.id_wb_pagina;
                    paginaModel.seccion.create({
                        fk_id_wb_pagina: idPag,
                        fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                        wb_margin: [10, 10, 10, 10],
                        wb_padding: [10, 10, 10, 10],
                        fk_id_cat_wb_width: 1,
                        wb_num_col: 1,
                        vigente: true,
                        f_reg: new Date(),
                        f_no_vigente: null,
                        orden_visible: 1
                    }).then(newSecc => {
                        const seccionCreada = newSecc.id_wb_pag_seccion;
                        paginaModel.columna.create({
                            fk_id_wb_pag_seccion: seccionCreada,
                            fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                            wb_padding: [10, 10, 10, 10],
                            orden_visible: 1,
                            vigente: true,
                            f_reg: new Date()
                        });
                    });
                    //// console.log('página creada! : '+paginaCreada.id_wb_pagina);
                    const idpagcy = jwt.sign(
                        {
                            idapp: idapp,
                            id_wb_pagina: paginaCreada.id_wb_pagina,
                            date_comp: new Date()
                        },
                        process.env.SECRET
                    );
                    dispararBitacoraPaginaAlta(id_user, idapp, paginaCreada.id_wb_pagina, type, req);
                    res.status(200).json({ success: true, message: 'Página guardada con éxito', pag: idpagcy });
                }).catch(error => {
                    console.error(error)
                    res.status(500).json({ success: false, error: 1, message: 'Error al generar la página ' });
                });
            }
        }
        else {
            // // console.log('----------------------PAG UPDATE '+idpag)
            if (type === 5) {
                tipo_tag = parseInt(req.body.tipo_tag);
                cont_full = req.body.cont_full;
            }
            if (req.file) {
                // // console.log('---Tiene archivo')
                let filename = 'cdn/websites/' + idapp + '/' + req.file.originalname;
                const blob = bucket.file(filename);
                const blobStream = blob.createWriteStream();

                blobStream.on("finish", () => {
                    filesModel.filesMain.create({
                        file_name: req.file.originalname,
                        file_type: req.file.mimetype,
                        file_size: req.file.size,
                        file_path: filename,
                        fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                    }).then(fileCreado => {
                        const idFile = fileCreado.id_file;
                        paginaModel.pagina.update(
                            {
                                fk_id_file: idFile
                            },
                            {
                                where: {
                                    id_wb_pagina: idpag
                                }
                            }
                        ).catch(error => {
                            console.error('2 Error al insertar el archivo o la página en la base de datos:', error);
                            res.status(500).json({ success: false, error: 1, message: '2 Error al insertar el archivo en la base de datos' });
                        })
                    }).catch(error => {
                        console.error('3 Error al insertar el archivo o la página en la base de datos:', error);
                        res.status(500).json({ success: false, error: 1, message: '3 Error al insertar el archivo en la base de datos' });
                    });

                });

                blobStream.on('error', (err) => {
                    console.error('Error al cargar el archivo:', err);
                    res.status(500).json({ success: false, error: 1, message: 'Error al cargar el archivo' });
                });

                blobStream.end(req.file.buffer);
            }
            if (parseInt(tipo_tag) !== 0) {
                // // console.log('---Tiene tag')
                const tags_count = await paginaModel.rel_wb_tag_pagina.count({
                    where: {
                        fk_id_cat_tag: tipo_tag,
                        fk_id_wb_pagina: idpag,
                        vigente: true
                    }
                });
                if (tags_count === 0) {
                    paginaModel.rel_wb_tag_pagina.update({
                        f_no_vigente: new Date(),
                        vigente: false
                    },
                        {
                            where: {
                                fk_id_wb_pagina: idpag
                            }
                        }).then(result => {
                            paginaModel.rel_wb_tag_pagina.create({
                                fk_id_cat_tag: tipo_tag,
                                fk_id_wb_pagina: idpag,
                                fk_id_user: id_user,
                                vigente: true
                            }).catch(error => {
                                console.error(error);
                                res.status(500).json({ success: false, error: 1, message: 'Error al actualizar la página' });
                            })
                        }).catch(error => {
                            console.error(error);
                            res.status(500).json({ success: false, error: 1, message: 'Error al actualizar la página' });
                        });
                }

            }

            paginaModel.pagina.update(
                {
                    nombre_pagina: namepag,
                    contenido_alt: cont_alt,
                    contenido: cont_full,
                    url_safe: url,
                    publicada: false,
                    f_publicacion: f_pub
                },
                {
                    where: {
                        id_wb_pagina: idpag
                    }
                }
            ).then(result => {
                if (result[0] === 1) {
                    //// console.log('Página actualizada correctamente' + idpag);
                    res.status(200).json({ success: true, message: 'Página actualizada con éxito' });
                } else {
                    res.status(404).json({ success: false, message: 'Página no encontrada' });
                }
            }).catch(error => {
                console.error(error);
                res.status(500).json({ success: false, error: 1, message: 'Error al actualizar la página' });
            });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function duplicarPagina(req, res) {
    const t = await dbConection.transaction();

    try {
        let cy = req.body.cy;
        let tipo_duplicado = parseInt(req.body.tipo_duplicado);
        let id_pag_nueva = req.body.id_pag_nueva;
        //// console.log(JSON.stringify(req.body));

        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        let id_wb_pagina = decoded.id_wb_pagina;
        let idapp = decoded.idapp;
        //// console.log("Pagina: "+id_wb_pagina);

        const token = req.cookies[process.env.APP_COOKIE_NAME];
        const usuario = jwt.verify(token, process.env.SECRET);
        const id_user = usuario.id_user;

        const paginaOriginal = await paginaModel.pagina.getDataPaginaID(id_wb_pagina);
        const pagOriginal = paginaOriginal[0];
        if (!pagOriginal) {
            return res.status(404).json({ success: false, message: 'Página original no encontrada' });
        }

        let nuevaPag;
        let bitacoraRegistrarNuevaPagDup = false;

        if (tipo_duplicado === 1) {
            // Reusar borrador vigente si existe (evita crear múltiples borradores por la misma página)
            const forceNew = /^(1|true|yes)$/i.test(String(req.body.forceNew || '').trim());
            const borradores = await paginaModel.rel_wb_pag_borrador.findAll({
                where: {
                    fk_pag_origen: pagOriginal.id_wb_pagina,
                    fk_id_cat_pag_tipo_borrador: 1,
                    vigente: true
                },
                order: [['f_reg', 'DESC']],
                raw: true,
                transaction: t
            });

            if (borradores.length > 0) {
                const keep = borradores[0];
                const extra = borradores.slice(1);

                // Si por datos históricos hay más de un borrador vigente, apagar los extras
                if (extra.length > 0) {
                    const extraIds = extra.map(b => b.fk_pag_nueva).filter(Boolean);
                    await paginaModel.rel_wb_pag_borrador.update(
                        { vigente: false },
                        {
                            where: {
                                fk_pag_origen: pagOriginal.id_wb_pagina,
                                fk_id_cat_pag_tipo_borrador: 1,
                                vigente: true,
                                fk_pag_nueva: { [Op.in]: extraIds }
                            },
                            transaction: t
                        }
                    );
                    if (extraIds.length) {
                        await paginaModel.pagina.update(
                            { vigente: false },
                            { where: { id_wb_pagina: { [Op.in]: extraIds }, vigente: true }, transaction: t }
                        );
                    }
                }

                if (!forceNew && keep && keep.fk_pag_nueva) {
                    await t.commit();
                    const cyBorrador = jwt.sign({
                        id_wb_pagina: keep.fk_pag_nueva,
                        idapp: idapp,
                        date_comp: new Date()
                    }, process.env.SECRET);

                    return res.status(200).json({ success: true, cy: cyBorrador });
                }
            }

            nuevaPag = await paginaModel.pagina.create({
                nombre_pagina: pagOriginal.nombre_pagina,
                contenido_alt: pagOriginal.contenido_alt,
                contenido: pagOriginal.contenido,
                fk_id_file: pagOriginal.fk_id_file,
                fk_id_cat_type_pagina: pagOriginal.fk_id_cat_type_pagina,
                fk_id_user: id_user,
                vigente: true,
                f_reg: new Date(),
                f_no_vigente: null,
                url_safe: pagOriginal.url_safe,
                fk_id_sysapp: idapp,
                publicada: false,
                f_publicacion: new Date()
            }, { transaction: t });
            bitacoraRegistrarNuevaPagDup = true;
        } else if (tipo_duplicado === 2) {
            if (id_pag_nueva) {
                nuevaPag = await paginaModel.pagina.findByPk(id_pag_nueva);
                if (!nuevaPag) throw new Error('No se encontró la nueva página creada');
            } else {
                // Modo duplicar directo: crear la página aquí (sin borrador tipo 1)
                nuevaPag = await paginaModel.pagina.create({
                    nombre_pagina: pagOriginal.nombre_pagina,
                    contenido_alt: pagOriginal.contenido_alt,
                    contenido: pagOriginal.contenido,
                    fk_id_file: pagOriginal.fk_id_file,
                    fk_id_cat_type_pagina: pagOriginal.fk_id_cat_type_pagina,
                    fk_id_user: id_user,
                    vigente: true,
                    f_reg: new Date(),
                    f_no_vigente: null,
                    url_safe: pagOriginal.url_safe,
                    fk_id_sysapp: idapp,
                    publicada: false,
                    f_publicacion: new Date()
                }, { transaction: t });
                bitacoraRegistrarNuevaPagDup = true;
            }
        } else {
            throw new Error('Tipo de duplicado no válido');
        }
        //// console.log("Pagina nueva: "+nuevaPag.id_wb_pagina);

        // Blindaje (SIEMPRE): si la nueva página ya trae secciones/columnas/componentes "default",
        // las marcamos como no vigentes antes de copiar la estructura de la página origen.
        const seccionesExist = await paginaModel.seccion.findAll({
            where: { fk_id_wb_pagina: nuevaPag.id_wb_pagina, vigente: true },
            attributes: ['id_wb_pag_seccion'],
            raw: true,
            transaction: t
        });
        if (seccionesExist.length) {
            const secIds = seccionesExist.map(s => s.id_wb_pag_seccion);
            const colsExist = await paginaModel.columna.findAll({
                where: { fk_id_wb_pag_seccion: { [Op.in]: secIds }, vigente: true },
                attributes: ['id_wb_pag_columna'],
                raw: true,
                transaction: t
            });
            const colIds = colsExist.map(c => c.id_wb_pag_columna);

            if (colIds.length) {
                await paginaModel.componente.update(
                    { vigente: false, f_no_vigente: new Date() },
                    { where: { fk_id_wb_pag_columna: { [Op.in]: colIds }, vigente: true }, transaction: t }
                );
                await paginaModel.columna.update(
                    { vigente: false, f_no_vigente: new Date() },
                    { where: { id_wb_pag_columna: { [Op.in]: colIds }, vigente: true }, transaction: t }
                );
            }

            await paginaModel.seccion.update(
                { vigente: false, f_no_vigente: new Date() },
                { where: { id_wb_pag_seccion: { [Op.in]: secIds }, vigente: true }, transaction: t }
            );
        }

        await paginaModel.rel_wb_pag_borrador.create({
            fk_pag_origen: pagOriginal.id_wb_pagina,
            fk_pag_nueva: nuevaPag.id_wb_pagina,
            fk_id_cat_pag_tipo_borrador: tipo_duplicado,
            vigente: true
        }, { transaction: t });

        for (const seccion of pagOriginal.secciones) {
            const secNueva = await paginaModel.seccion.create({
                fk_id_wb_pagina: nuevaPag.id_wb_pagina,
                fk_id_cat_wb_visible: seccion.fk_id_cat_wb_visible,
                wb_margin: seccion.wb_margin,
                wb_padding: seccion.wb_padding,
                fk_id_cat_wb_width: seccion.fk_id_cat_wb_width,
                wb_num_col: seccion.wb_num_col,
                orden_visible: seccion.orden_visible,
                vigente: true,
                f_reg: new Date()
            }, { transaction: t });
            //// console.log('Sección creada:', secNueva.dataValues);

            for (const columna of seccion.columnas) {
                const colNueva = await paginaModel.columna.create({
                    fk_id_wb_pag_seccion: secNueva.id_wb_pag_seccion,
                    fk_id_cat_wb_visible: columna.fk_id_cat_wb_visible,
                    wb_padding: columna.wb_padding,
                    orden_visible: columna.orden_visible,
                    vigente: true,
                    f_reg: new Date()
                }, { transaction: t });
                // // console.log('Columna creada:', colNueva.dataValues);

                for (const componente of columna.componentes) {
                    const compNuevo = await paginaModel.componente.create({
                        fk_id_wb_pag_columna: colNueva.id_wb_pag_columna,
                        fk_id_cat_wb_visible: componente.fk_id_cat_wb_visible,
                        wb_padding: componente.wb_padding,
                        fk_id_cat_wb_componente: componente.fk_id_cat_wb_componente,
                        orden_visible: componente.orden_visible,
                        vigente: true,
                        f_reg: new Date()
                    }, { transaction: t });
                    // // console.log('Componente creado:', compNuevo.dataValues);

                    const tipoComp = await paginaModel.tipoComponente.findByPk(componente.fk_id_cat_wb_componente);
                    if (tipoComp && tipoComp.table_componente) {
                        const tabla_comp = tipoComp.table_componente;

                        const compOriginal = await paginaModel[tabla_comp].findOne({
                            where: { fk_id_wb_pag_componente: componente.id_wb_pag_componente },
                            raw: true
                        });

                        if (!compOriginal) {
                            throw new Error(`No se encontró contenido para el componente de ${tabla_comp}`);
                        }

                        const id_componente_original = componente.id_wb_pag_componente;
                        //// console.log("id_componente_original: " + id_componente_original);

                        delete compOriginal.fk_id_wb_pag_componente;
                        delete compOriginal.fk_id_wb_pagina;
                        delete compOriginal['id_' + tabla_comp];
                        //// console.log(compOriginal);

                        const nuevoReg = await paginaModel[tabla_comp].create({
                            ...compOriginal,
                            fk_id_wb_pag_componente: compNuevo.id_wb_pag_componente,
                            fk_id_wb_pagina: nuevaPag.id_wb_pagina,
                        }, { transaction: t });

                        const idComp = nuevoReg['id_' + tabla_comp];
                        //// console.log("idComp: "+idComp);

                        const tiene_dependencia = {
                            wb_comp_carrousel: 'wb_comp_slides_carrousel',
                            wb_comp_linea: 'wb_comp_slides_linea',
                            wb_comp_galeria: 'wb_comp_slides_galeria',
                            wb_comp_tabs: 'wb_comp_tab_tabs'
                        };

                        if (tiene_dependencia[tabla_comp]) {

                            const data_comp = await paginaModel[tabla_comp].findOne({ where: { fk_id_wb_pag_componente: id_componente_original } });
                            const id_comp_tabla = data_comp['id_' + tabla_comp];
                            let slidecontent = await paginaModel.componente.getSlideContent(id_comp_tabla, tabla_comp);

                            //// console.log("Cant slides: "+slidecontent.length);
                            if (slidecontent.length != 0) {
                                for (const slides of slidecontent) {
                                    const fk_slides = 'fk_id_' + tabla_comp;
                                    //// console.log(slides);
                                    delete slides[fk_slides];
                                    delete slides['id_' + tiene_dependencia[tabla_comp]];
                                    delete slides['fk_id_wb_pagina'];

                                    // return false;
                                    const nuevoSlide = await paginaModel[tiene_dependencia[tabla_comp]].create({
                                        ...slides,
                                        [fk_slides]: idComp,
                                        fk_id_wb_pagina: nuevaPag.id_wb_pagina
                                    }, { transaction: t });
                                    //// console.log('Slide insertado:', nuevoSlide.dataValues);
                                }
                            } else {
                                throw new Error(`No se encontraron slides para el componente duplicado de tipo ${tabla_comp}`);
                            }
                        }
                    }
                }
            }
        }

        await t.commit();

        if (bitacoraRegistrarNuevaPagDup) {
            const tipoDup = Number(
                typeof nuevaPag.getDataValue === 'function'
                    ? nuevaPag.getDataValue('fk_id_cat_type_pagina')
                    : nuevaPag.fk_id_cat_type_pagina
            );
            dispararBitacoraPaginaAlta(id_user, idapp, nuevaPag.id_wb_pagina, tipoDup, req);
        }

        const nuevoCy = jwt.sign({
            id_wb_pagina: nuevaPag.id_wb_pagina,
            idapp: idapp,
            date_comp: new Date()
        }, process.env.SECRET);

        const returnOnly = /^(1|true|yes)$/i.test(String(req.body.returnOnly || '').trim());
        if (tipo_duplicado === 2 || returnOnly) {
            return {
                success: true,
                cy: nuevoCy
            }
        } else {
            res.status(200).json({
                success: true,
                cy: nuevoCy
            });
        }

    } catch (error) {
        await t.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function getBorPag(req, res) {
    try {
        const { id_bor, hasBo, cy, accion } = req.body;
        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);

        if (!decoded) throw new Error('Alerta en jwt en petición')
        let comparedates = utilFun.compareDates(decoded.date_comp)

        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let id_wb_pagina = decoded.id_wb_pagina;
        let idapp = decoded.idapp;

        const pagina_borrador = await paginaModel.rel_wb_pag_borrador.findOne({
            where: {
                fk_pag_nueva: id_bor,
                vigente: true
            }
        });

        if (accion === 'Descartar') {
            await paginaModel.pagina.update(
                { vigente: false },
                { where: { id_wb_pagina: id_bor } }
            );
            await paginaModel.rel_wb_pag_borrador.update(
                { vigente: false },
                { where: { id_rel_wb_pag_borrador: pagina_borrador.id_rel_wb_pag_borrador } }
            );

            return res.status(200).json({
                success: true,
                tipos: 2,
                message: 'El borrador fue eliminado exitosamente.',
                redirect: false
            });

        } else if (accion === 'Continuar') {
            const cy_borrador = jwt.sign({
                id_wb_pagina: id_bor,
                idapp: idapp,
                date_comp: new Date()
            }, process.env.SECRET
            );

            return res.status(200).json({
                success: true,
                tipos: 1,
                cy: cy_borrador,
                message: 'Redirigiendo al borrador existente.'
            });
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function getSec(req, res) {
    const t = await dbConection.transaction();
    try {
        let { newsec, idpag, ordenprev, num_col } = req.body;
        const ordenAnterior = (typeof ordenprev === 'number' && !isNaN(ordenprev)) ? ordenprev : 0;
        const nuevoOrden = ordenAnterior + 1;

        // Número de columnas solicitado (por defecto 1 para compatibilidad)
        let totalColumnas = 1;
        const numColParsed = parseInt(num_col, 10);
        if (!isNaN(numColParsed) && numColParsed > 0) {
            // Limitar a un máximo razonable de columnas
            totalColumnas = Math.min(numColParsed, 4);
        }

        const newSec = await paginaModel.seccion.create({
            fk_id_wb_pagina: idpag,
            fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
            wb_margin: [10, 10, 10, 10],
            fk_id_cat_wb_width: 1,
            wb_num_col: totalColumnas,
            vigente: true,
            f_reg: new Date(),
            orden_visible: nuevoOrden
        }, { transaction: t });

        // Crear columnas de la sección (al menos una, hasta totalColumnas)
        const columnasCreadas = [];
        for (let i = 1; i <= totalColumnas; i++) {
            const col = await paginaModel.columna.create({
                fk_id_wb_pag_seccion: newSec.id_wb_pag_seccion,
                fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                wb_padding: [10, 10, 10, 10],
                orden_visible: i,
                vigente: true,
                f_reg: new Date()
            }, { transaction: t });
            columnasCreadas.push(col);
        }

        // Obtener todas las secciones ordenadas correctamente
        const seccionesOrdenadas = await paginaModel.seccion.findAll({
            where: {
                fk_id_wb_pagina: idpag,
                vigente: true,
                id_wb_pag_seccion: {
                    [Op.ne]: newSec.id_wb_pag_seccion
                }
            },
            order: [['orden_visible', 'ASC'], ['id_wb_pag_seccion', 'ASC']],
            transaction: t
        });

        // Reordenar las secciones existentes
        let ordenCounter = 1;
        for (const seccion of seccionesOrdenadas) {
            // Si llegamos al orden donde debe insertarse la nueva sección, saltamos ese número
            if (ordenCounter === nuevoOrden) {
                ordenCounter++;
            }

            // Actualizar el orden de la sección existente
            await paginaModel.seccion.update({ orden_visible: ordenCounter },
                {
                    where: {
                        id_wb_pag_seccion: seccion.id_wb_pag_seccion
                    },
                    transaction: t
                });
            ordenCounter++;
        }

        await t.commit();
        //// console.log("Sección creada con exito");
        return res.status(200).json({
            success: true,
            message: 'Sección creada correctamente',
            id_sec: newSec.id_wb_pag_seccion,
            col_inicial: columnasCreadas[0].id_wb_pag_columna,
            cols_creadas: columnasCreadas.map(c => c.id_wb_pag_columna),
            num_col: newSec.wb_num_col,
            orden: newSec.orden_visible
        });
    } catch (error) {
        await t.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function getCol(req, res) {
    try {
        let { columna, sec, columnas_div } = req.body;
        //// console.log(req.body);

        const idSec = parseInt(sec, 10);
        if (!Number.isNaN(idSec)) {
            const columnasSec = await paginaModel.columna.findAll({
                where: { fk_id_wb_pag_seccion: idSec, vigente: true },
                attributes: ['id_wb_pag_columna']
            });
            const colIds = columnasSec.map((c) => c.id_wb_pag_columna);
            if (colIds.length) {
                const componentesEnSeccion = await paginaModel.componente.findAll({
                    where: {
                        fk_id_wb_pag_columna: { [Op.in]: colIds },
                        vigente: true
                    },
                    attributes: ['fk_id_cat_wb_componente']
                });
                const bloquea = componentesEnSeccion.some((row) => {
                    const tid = row.fk_id_cat_wb_componente;
                    return tid != null && isFullWidthComponentType(tid);
                });
                if (bloquea) {
                    return res.status(200).json({
                        success: false,
                        message:
                            'No se pueden añadir columnas: esta sección incluye un componente que requiere el ancho completo.'
                    });
                }
            }
        }

        const colsExists = await paginaModel.columna.findAll({
            where: {
                fk_id_wb_pag_seccion: sec,
                vigente: true
            },
            order: [['orden_visible', 'ASC']]
        });

        let nuevoOrden = 1;
        if (colsExists.length > 0) {
            const ultimoOrden = colsExists[colsExists.length - 1].orden_visible;
            nuevoOrden = ultimoOrden + 1;
        }

        const newCol = await paginaModel.columna.create({
            fk_id_wb_pag_seccion: sec,
            fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
            wb_padding: [10, 10, 10, 10],
            vigente: true,
            f_reg: new Date(),
            orden_visible: nuevoOrden
        });

        await paginaModel.seccion.update(
            { wb_num_col: colsExists.length + 1 },
            { where: { id_wb_pag_seccion: sec } }
        );

        //// console.log("Columna creada con exito");
        return res.status(200).json({
            success: true,
            message: 'Columna creada correctamente',
            id_columna: newCol.id_wb_pag_columna,
            orden: newCol.orden_visible
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function deleteCol(req, res) {
    try {
        let { col, sec } = req.body;
        //// console.log(req.body);

        if (col == null || col === '' || sec == null || sec === '') {
            return res.status(400).json({
                success: false,
                message: 'Identificador de columna o sección no válido.'
            });
        }

        const idCol = parseInt(col, 10);
        const idSec = parseInt(sec, 10);
        if (Number.isNaN(idCol) || Number.isNaN(idSec)) {
            return res.status(400).json({
                success: false,
                message: 'Identificador de columna o sección no válido.'
            });
        }

        await paginaModel.columna.update({
            vigente: false,
            f_no_vigente: new Date()
        }, {
            where: {
                id_wb_pag_columna: idCol,
                fk_id_wb_pag_seccion: idSec,
                vigente: true
            }
        });

        const cols_debt = await paginaModel.columna.count({
            where: {
                fk_id_wb_pag_seccion: idSec,
                vigente: true
            }
        });
        //// console.log("cols debt: "+cols_debt);

        await paginaModel.seccion.update(
            { wb_num_col: cols_debt },
            { where: { id_wb_pag_seccion: idSec } }
        );

        //// console.log("Columna eliminada con exito");
        res.status(200).json({
            success: true,
            message: 'Columna eliminada correctamente',
            num_cols: cols_debt
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function deleteSec(req, res) {
    const t = await dbConection.transaction();
    try {
        let { sec, idpag } = req.body;

        const seccionEliminada = await paginaModel.seccion.findOne({
            where: { id_wb_pag_seccion: sec, fk_id_wb_pagina: idpag, vigente: true },
            attributes: ['orden_visible'],
            transaction: t
        });

        if (!seccionEliminada) {
            await t.rollback();
            return res.status(404).json({ success: false, message: 'La sección no existe o ya fue eliminada.' });
        }

        const ordenEliminado = seccionEliminada.orden_visible;

        //1. Buscar cols en la seccion
        let colsInSecc = await paginaModel.columna.findAll({
            where: { fk_id_wb_pag_seccion: sec, vigente: true },
            transaction: t
        });
        let cols = colsInSecc.map(c => c.id_wb_pag_columna);

        //2. si hay columnas buscar comps
        if (cols.length > 0) {
            let componentInCols = await paginaModel.componente.findAll({
                where: { fk_id_wb_pag_columna: { [Op.in]: cols }, vigente: true },
                transaction: t
            });

            //3. si hay componentes, desactivarlos
            if (componentInCols.length > 0) {
                let componentes = componentInCols.map(c => c.id_wb_pag_componente);

                await paginaModel.componente.update(
                    { vigente: false, f_no_vigente: new Date() },
                    { where: { id_wb_pag_componente: { [Op.in]: componentes } }, transaction: t }
                );
            }

            //4. marcar cols como no vigentes
            await paginaModel.columna.update(
                { vigente: false, f_no_vigente: new Date() },
                { where: { id_wb_pag_columna: { [Op.in]: cols }, vigente: true }, transaction: t }
            );
        }

        //5. marcar secc como no vigente
        await paginaModel.seccion.update(
            { vigente: false, f_no_vigente: new Date() },
            { where: { id_wb_pag_seccion: sec, fk_id_wb_pagina: idpag }, transaction: t }
        );

        // Obtener todas las secciones vigentes ordenadas
        const seccionesVigentes = await paginaModel.seccion.findAll({
            where: {
                fk_id_wb_pagina: idpag,
                vigente: true
            },
            order: [['orden_visible', 'ASC']],
            transaction: t
        });

        // Reordenar todas las secciones vigentes secuencialmente
        let nuevoOrden = 1;
        for (const seccion of seccionesVigentes) {
            await paginaModel.seccion.update(
                { orden_visible: nuevoOrden },
                {
                    where: {
                        id_wb_pag_seccion: seccion.id_wb_pag_seccion
                    },
                    transaction: t
                });
            nuevoOrden++;
        }

        //6. verificar si quedan secciones vigentes en la pag
        const seccRest = await paginaModel.seccion.findAll({
            where: { fk_id_wb_pagina: idpag, vigente: true },
            transaction: t
        });

        if (seccRest.length === 0) {
            const newSec = await paginaModel.seccion.create({
                fk_id_wb_pagina: idpag,
                fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                wb_margin: [10, 10, 10, 10],
                fk_id_cat_wb_width: 1,
                wb_num_col: 1,
                vigente: true,
                f_reg: new Date(),
                orden_visible: 1
            }, { transaction: t });

            await paginaModel.columna.create({
                fk_id_wb_pag_seccion: newSec.id_wb_pag_seccion,
                fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                wb_padding: [10, 10, 10, 10],
                orden_visible: 1,
                vigente: true,
                f_reg: new Date()
            }, { transaction: t });
        }

        await t.commit();

        res.status(200).json({
            success: true,
            message: 'Sección eliminada correctamente',
        });
    } catch (error) {
        await t.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function reorderSec(req, res) {
    const t = await dbConection.transaction();
    try {
        const { idpag, idsec, direction } = req.body;
        const result = await paginaModel.intercambiarOrdenSeccionesAdyacentes(idpag, idsec, direction, t);
        if (!result.success) {
            await t.rollback();
            return res.status(result.status || 400).json({ success: false, message: result.message });
        }
        await t.commit();
        return res.status(200).json({
            success: true,
            message: 'Orden de secciones actualizado.',
            ordenes: result.ordenes
        });
    } catch (error) {
        await t.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error al reordenar la sección.' });
    }
}

async function CreateComp(req, res) {
    try {
        const cy = req.body.cy;
        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);

        if (!decoded) throw new Error('Alerta en jwt en petición');
        let comparedates = utilFun.compareDates(decoded.date_comp);

        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let idapp = decoded.idapp;

        let { dataComp, tablecomp, orden } = req.body; // Data de los componentes
        let { idpag, idsec, idcol } = req.body; // Data de la configuración

        // Validar y convertir idcol a entero
        if (idcol === '' || idcol === null || idcol === undefined) {
            return res.status(400).json({
                success: false,
                message: 'El ID de columna es requerido',
            });
        }
        idcol = parseInt(idcol, 10);
        if (isNaN(idcol)) {
            return res.status(400).json({
                success: false,
                message: 'El ID de columna debe ser un número válido',
            });
        }

        //console.log(req.body);
        //console.log(req.files);
        //return;

        /* Definición de las tablas de los componentes
           Si llegan a existir más componentes solo se agrega la nueva tabla al tipo que le corresponda */
        let CompTagModalTemplate = ['wb_comp_noticias', 'wb_comp_coleccion_fotografica', 'wb_comp_cards_regeneracion'];
        let CompTabTabsModelTemplate = ['', ''];
        let CompTextImgModelTemplate = ['wb_comp_titulopag', 'wb_comp_flip', 'wb_comp_personas', 'wb_comp_video', 'wb_comp_cards'];
        let CompTextoModelTemplate = ['wb_comp_subtitulo', 'wb_comp_texto', 'wb_comp_boton'];
        let ImagenModelTemplate = ['wb_comp_img'];
        let RedesModelTemplate = ['wb_comp_redes'];

        // Search type comp into wb_cat_wb_componente
        const type_comp = await paginaModel.tipoComponente.findOne({
            where: {
                id_cat_wb_componente: dataComp,
                table_componente: tablecomp,
                vigente: true
            }
        });
        if (!type_comp) {
            return res.status(200).json({
                success: false,
                message: 'El componente no existe o no está disponible',
            });
        }
        if (type_comp.table_componente !== tablecomp) {
            return res.status(200).json({
                success: false,
                message: 'El componente no coincide con la tabla especificada',
            });
        }

        // Create wb_pag_componente:
        let objPagComp = {
            fk_id_wb_pag_columna: idcol,
            fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
            wb_padding: [10, 10, 10, 10],
            vigente: true,
            f_reg: new Date(),
            orden_visible: orden,
            fk_id_cat_wb_componente: type_comp.id_cat_wb_componente
        };
        let newPagComp = objPagComp;
        let pagcomp = await paginaModel.componente.create({ ...newPagComp });
        if (!pagcomp || !pagcomp.id_wb_pag_componente) {
            return res.status(500).json({
                success: false,
                message: 'Error al crear el componente.',
            });
        }

        // Insert in storage & files
        // Validación de archivos
        let fileId = null;
        const skipFile = req.body.skipFile === 'true' || req.body.skipFile === true;

        if (CompTextImgModelTemplate.includes(tablecomp) || ImagenModelTemplate.includes(tablecomp)) {
            // Imágenes desde el módulo (selector): usar IDs de req.body si no hay archivos subidos.
            // Los slides del modal envían `fk_id_file[]` (igual que AddSlides); sin esto CreateComp falla aunque haya imagen.
            let rawFileIds = req.body['fk_id_file[]'];
            if (rawFileIds == null && req.body.fk_id_file != null) rawFileIds = req.body.fk_id_file;
            let firstFileIdFromBody = null;
            if (rawFileIds != null) {
                const arr = Array.isArray(rawFileIds)
                    ? rawFileIds
                    : String(rawFileIds).split(',').map((s) => s.trim()).filter(Boolean);
                for (const x of arr) {
                    const n = parseInt(x, 10);
                    if (!Number.isNaN(n)) {
                        firstFileIdFromBody = n;
                        break;
                    }
                }
            }
            const hasFileIdsFromBody = firstFileIdFromBody != null;
            if (!req.files && !skipFile && !hasFileIdsFromBody) {
                return res.status(500).json({
                    success: false,
                    message: 'Error al cargar el componente.',
                });
            }

            if (hasFileIdsFromBody && (!req.files || req.files.length === 0)) {
                fileId = firstFileIdFromBody;
            } else if (req.files && req.files.length > 0) {
                // https://cdn.morena.app/cdn/websites/2/isabel%20allende.webp
                // Para título principal, el primer archivo es la imagen derecha (images)
                // El segundo archivo (si existe) es la imagen izquierda (images_izq)
                const file = req.files.find(f => f.fieldname === 'images') || req.files[0];

                const filename = `cdn/websites/${idapp}/${file.originalname}`;
                const blob = bucket.file(filename);
                const blobStream = blob.createWriteStream();

                //console.log("filename: "+filename);

                await new Promise((resolve, reject) => {
                    blobStream.on("error", reject);
                    blobStream.on("finish", resolve);
                    blobStream.end(file.buffer);
                });

                let newFile = await filesModel.filesMain.create({
                    file_name: file.originalname,
                    file_type: file.mimetype,
                    file_size: file.size,
                    file_path: filename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                });

                fileId = newFile.id_file;
                console.log("ID del file creado:", fileId);
            } else if (!skipFile) {
                return res.status(400).json({
                    success: false,
                    message: 'Error al subir el archivo.',
                });
            } else if (skipFile) {
                // Para componentes que requieren archivo (como video, etc.), crear un archivo placeholder cuando skipFile es true.
                // Card y personas NO: usan imagen de referencia local (/assets/img/default_morena.png) hasta que el usuario suba una.
                const componentNeedsFile = ['wb_comp_video', 'wb_comp_titulopag', 'wb_comp_flip', 'wb_comp_img'];
                
                if (componentNeedsFile.includes(tablecomp)) {
                    // Determinar el tipo de archivo según el componente
                    let fileExtension = 'jpg';
                    let contentType = 'image/jpeg';
                    let fileName = 'placeholder.jpg';
                    
                    if (tablecomp === 'wb_comp_video') {
                        fileExtension = 'mp4';
                        contentType = 'video/mp4';
                        fileName = 'placeholder_video.mp4';
                    }
                    
                    const placeholderFilename = `cdn/websites/${idapp}/placeholder_${tablecomp}_${Date.now()}.${fileExtension}`;
                    const placeholderBlob = bucket.file(placeholderFilename);
                    
                    // Crear un archivo placeholder vacío
                    const placeholderContent = Buffer.from(''); // Archivo vacío como placeholder
                    const placeholderStream = placeholderBlob.createWriteStream({
                        metadata: {
                            contentType: contentType
                        }
                    });

                    await new Promise((resolve, reject) => {
                        placeholderStream.on("error", reject);
                        placeholderStream.on("finish", resolve);
                        placeholderStream.end(placeholderContent);
                    });

                    let placeholderFile = await filesModel.filesMain.create({
                        file_name: fileName,
                        file_type: contentType,
                        file_size: 0,
                        file_path: placeholderFilename,
                        fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                    });

                    fileId = placeholderFile.id_file;
                    console.log(`ID del archivo placeholder creado para ${tablecomp}:`, fileId);
                }
            }
            // Si skipFile es true y no es video, continuar sin archivo (fileId será null)
        }

        // Config de componentes tipo tag
        // field es lo que llega de body
        const tagConfig = {
            wb_comp_noticias: {
                type: "entrada",
                field: "fk_id_cat_tag",
                content_tag: 1,
                relation: "paginas"
            },
            wb_comp_coleccion_fotografica: {
                type: "imagen",
                field: "fk_id_cat_tag",
                content_tag: 3,
                relation: "colecciones"
            },
            wb_comp_cards_regeneracion: {
                type: "regeneracion",
                field: "anio_seleccionado",
            },
        };

        let tag = null;
        let content_tag = null;
        let meta = null;

        if (CompTagModalTemplate.includes(tablecomp)) {
            const config = tagConfig[tablecomp];
            //return;
            if (config) {
                if (tablecomp === 'wb_comp_cards_regeneracion') {
                    //console.log("Componente de regeneración");

                    const anioSeleccionado = req.body[config.field];
                    //console.log("Año seleccionado: " + anioSeleccionado);

                    tag = null;
                    content_tag = 1; //documentos
                    meta = {
                        anio: anioSeleccionado
                    };
                } else {
                    tag = req.body[config.field];
                    content_tag = config.content_tag;
                }
            }
        }

        // Variables dinámicas
        let comp_create;
        let id_comp_create;
        let id_pag_component_create = pagcomp.id_wb_pag_componente;
        let id_file_create = fileId;

        let objComp_hasfile = { // obj para insertar datos del comp correspondiente con imagen
            fk_id_wb_pag_componente: id_pag_component_create,
            texto: req.body.texto,
            fk_id_file: id_file_create,
            vigente: true,
            f_reg: new Date(),
            f_no_vigente: null
        };
        let objComp_nofile = {
            fk_id_wb_pag_componente: id_pag_component_create,
            texto: req.body.texto,
            vigente: true,
            f_reg: new Date(),
            f_no_vigente: null
        };
        let objComp_tags = {
            fk_id_wb_pag_componente: id_pag_component_create,
            fk_id_cat_tag: tag,
            vigente: true,
            f_reg: new Date(),
            f_no_vigente: null
        };
        let objComp_redes = {
            fk_id_wb_pag_componente: id_pag_component_create,
            facebook: req.body.facebook,
            facebook_link: req.body.facebook_link,
            instagram: req.body.instagram,
            instagram_link: req.body.instagram_link,
            tiktok: req.body.tiktok,
            tiktok_link: req.body.tiktok_link,
            x_twitter: req.body.x_twitter,
            x_twitter_link: req.body.x_twitter_link,
            yt: req.body.yt,
            yt_link: req.body.yt_link,
            color_acento: normalizeColorAccent(req.body.color_acento),
            vigente: true,
            f_reg: new Date(),
            f_no_vigente: null
        };
        let objComp_img = {
            fk_id_wb_pag_componente: id_pag_component_create,
            fk_id_file: id_file_create,
            url_link: req.body.url_link || null,
            wb_padding: [0, 0, 0, 0],
            vigente: true,
            f_reg: new Date(),
            f_no_vigente: null
        };
        let objComp_regeneracion = {
            fk_id_wb_pag_componente: id_pag_component_create,
            fk_id_cat_wb_type_content_tag: content_tag,
            anio_seleccionado: meta?.anio || null,
            vigente: true,
            f_reg: new Date(),
            f_no_vigente: null
        };

        //console.log("Insertando componente en tabla:", tablecomp);
        // Insert comps
        switch (tablecomp) {
            case 'wb_comp_titulopag':
                // Manejar imagen izquierda y color del filtro para título principal
                let fileIdIzq = null;
                let colorFiltro = req.body.color_filtro || '#8B0000';
                if (req.body.fk_id_file_izq != null && String(req.body.fk_id_file_izq).trim() !== '') {
                    const idIzq = parseInt(req.body.fk_id_file_izq, 10);
                    if (!isNaN(idIzq)) fileIdIzq = idIzq;
                }
                // Buscar el archivo de imagen izquierda (images_izq) solo si no vino por body
                if (fileIdIzq == null && req.files && req.files.length > 0) {
                    const fileIzq = req.files.find(f => f.fieldname === 'images_izq');
                    if (fileIzq) {
                        const filenameIzq = `cdn/websites/${idapp}/${Date.now()}_${fileIzq.originalname}`;
                        const blobIzq = bucket.file(filenameIzq);
                        const blobStreamIzq = blobIzq.createWriteStream();

                        await new Promise((resolve, reject) => {
                            blobStreamIzq.on("error", reject);
                            blobStreamIzq.on("finish", resolve);
                            blobStreamIzq.end(fileIzq.buffer);
                        });

                        let newFileIzq = await filesModel.filesMain.create({
                            file_name: fileIzq.originalname,
                            file_type: fileIzq.mimetype,
                            file_size: fileIzq.size,
                            file_path: filenameIzq,
                            fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                        });

                        fileIdIzq = newFileIzq.id_file;
                    }
                }
                
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_hasfile,
                    fk_id_file_izq: fileIdIzq,
                    color_filtro: colorFiltro,
                    texto: req.body.texto || ''
                });
                break;
            case 'wb_comp_subtitulo':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_nofile
                });
                break;
            case 'wb_comp_texto':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_nofile,
                    wb_padding: [0, 0, 0, 0]
                });
                break;
            case 'wb_comp_boton':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_nofile,
                    liga: req.body.liga,
                    fk_id_wb_pagina: idpag,
                    color: null
                });
                break;
            case 'wb_comp_flip':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_hasfile,
                    titulo: req.body.titulo,
                    url_link: req.body.url_link,
                    fk_id_wb_pagina: idpag,
                    color_acento: normalizeColorAccent(req.body.color_acento),
                });
                break;
            case 'wb_comp_noticias':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_tags,
                });
                break;
            case 'wb_comp_cards':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_hasfile,
                    fk_id_file: fileId || null,
                    titulo: req.body.titulo,
                    url_link: req.body.url_link,
                });
                break;
            case 'wb_comp_redes':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_redes
                });
                break;
            case 'wb_comp_cards_regeneracion':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_regeneracion
                });
                break;
            case 'wb_comp_img': // pendiente
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_img
                });
                break;
            case 'wb_comp_personas':
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_hasfile,
                    fk_id_file: fileId || null,
                    titulo: req.body.titulo,
                    color_acento: normalizeColorAccent(req.body.color_acento),
                });
                break;
            case 'wb_comp_video':
                // f_video debe ser una fecha válida (timestamp), no un string como 'External'
                let f_video_value = req.body.f_video;
                if (!f_video_value || f_video_value === 'External' || (typeof f_video_value === 'string' && !f_video_value.match(/^\d{4}-\d{2}-\d{2}/))) {
                    // Si no es una fecha válida, usar la fecha actual
                    f_video_value = new Date();
                } else if (typeof f_video_value === 'string') {
                    // Si es un string que parece fecha, convertir a Date
                    f_video_value = new Date(f_video_value);
                }
                
                comp_create = await paginaModel[tablecomp].create({
                    ...objComp_hasfile,
                    titulo: req.body.titulo,
                    f_video: f_video_value,
                    url_link: req.body.url_link
                });
                break;
            case 'wb_comp_coleccion_fotografica': {
                let type_tag_img = Array.isArray(req.body.fk_id_cat_tag) ? req.body.fk_id_cat_tag : [req.body.fk_id_cat_tag];
                type_tag_img = type_tag_img.filter(t => t != null && t !== '' && t !== '0' && t !== 0);
                const idsTagImg = [];

                for (let tag of type_tag_img) {
                    const newCompColeccion = await paginaModel[tablecomp].create({
                        fk_id_wb_pag_componente: id_pag_component_create,
                        fk_id_cat_tag: tag,
                        fk_id_cat_wb_type_content_tag: tagConfig[tablecomp].content_tag,
                        vigente: true,
                        f_reg: new Date(),
                        f_no_vigente: null
                    });

                    idsTagImg.push(newCompColeccion.id_wb_comp_coleccion_fotografica);
                }

                comp_create = idsTagImg.length > 0 ? idsTagImg[0] : null;
                break;
            }
        }

        if (comp_create) {
            return res.status(200).json({
                success: true,
                message: 'Componente creado exitosamente.',
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'No se puede guardar el componente, intente más tarde.',
            });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function getCompDataToEdit(req, res) {
    try {
        const idcomp = req.body.idcomp;
        // console.log("ID recibido para editar:", idcomp);

        // 1. Buscar componente general
        const comp = await paginaModel.componente.findOne({
            where: { id_wb_pag_componente: idcomp, f_no_vigente: null },
            include: [{
                model: paginaModel.tipoComponente,
                as: 'tipoComponente',
                attributes: ['table_componente', 'type_componente']
            }]
        });

        if (!comp) {
            return res.status(404).json({
                success: false,
                message: 'El componente no existe o ya está eliminado',
            });
        }

        const table_comp = comp.tipoComponente.table_componente;
        const tipo_componente = comp.tipoComponente.type_componente;
        const tipoCompId = comp.fk_id_cat_wb_componente;

        // console.log("📌 Tabla específica del componente:", table_comp);

        // 2. Buscar datos específicos del componente
        let compEspecifico = null;
        if (table_comp === 'wb_comp_acordeon') {
            compEspecifico = await paginaModel.wb_contenedor_acordeon.findOne({
                where: { fk_id_wb_pag_componente: idcomp, vigente: true }
            });
        } else {
            compEspecifico = await paginaModel[table_comp].findOne({
                where: { fk_id_wb_pag_componente: idcomp, f_no_vigente: null }
            });
        }

        if (!compEspecifico) {
            return res.status(404).json({
                success: false,
                message: 'No se encontraron datos específicos del componente',
            });
        }

        let datosAdicionales = {};

        // Validación especial para componentes tipo slide
        const slideComponents = ['wb_comp_carrousel', 'wb_comp_galeria', 'wb_comp_linea'];
        if (slideComponents.includes(table_comp)) {
            // Mapeo de tablas principales a tablas de slides
            const slideTableMap = {
                'wb_comp_carrousel': 'wb_comp_slides_carrousel',
                'wb_comp_galeria': 'wb_comp_slides_galeria',
                'wb_comp_linea': 'wb_comp_slides_linea'
            };

            // Mapeo de FK para cada tipo
            const fkMap = {
                'wb_comp_carrousel': { fk: 'fk_id_wb_comp_carrousel', id: compEspecifico.id_wb_comp_carrousel },
                'wb_comp_galeria': { fk: 'fk_id_wb_comp_galeria', id: compEspecifico.id_wb_comp_galeria },
                'wb_comp_linea': { fk: 'fk_id_wb_comp_linea', id: compEspecifico.id_wb_comp_linea }
            };

            const slideTable = slideTableMap[table_comp];
            const fkInfo = fkMap[table_comp];

            // Obtener los slides
            const slides = await paginaModel[slideTable].findAll({
                where: { [fkInfo.fk]: fkInfo.id, f_no_vigente: null },
                raw: true,
                order: [['orden_visible', 'ASC']]
            });

            // Normalizar fk_id_file (puede venir como array, string "{1,2,3}" o número)
            function normalizeSlideFileIds(value) {
                if (value == null) return [];
                if (Number.isInteger(value) || (typeof value === 'string' && /^\d+$/.test(value))) return [parseInt(value, 10)];
                if (Array.isArray(value)) return value.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
                if (typeof value === 'string') {
                    if (value.startsWith('[')) { try { const arr = JSON.parse(value); return Array.isArray(arr) ? arr.map(id => parseInt(id, 10)).filter(n => !isNaN(n)) : []; } catch (_) { return []; } }
                    if (value.startsWith('{')) {
                        const inner = value.replace(/^\{|\}$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''));
                        return inner.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
                    }
                }
                return [];
            }

            // Procesar cada slide y extraer base64 de imágenes
            datosAdicionales.data = [];
            for (const slide of slides) {
                const slideObj = { ...slide };
                const fileIds = normalizeSlideFileIds(slide.fk_id_file);
                slideObj.fk_id_file = fileIds;
                slideObj.foto = [];
                for (const fileId of fileIds) {
                    try {
                        const foto = await filesModel.verFoto(null, fileId);
                        if (foto && foto.image) {
                            slideObj.foto.push(`data:${foto.type};base64,${foto.image.toString('base64')}`);
                        } else {
                            slideObj.foto.push('');
                        }
                    } catch (e) {
                        console.warn('getCompDataToEdit: verFoto falló para fileId', fileId, e.message);
                        slideObj.foto.push('');
                    }
                }
                datosAdicionales.data.push(slideObj);
            }
        } else {
            // Componentes normales
            datosAdicionales.data = await paginaModel[table_comp].findAll({
                where: { fk_id_wb_pag_componente: idcomp, f_no_vigente: null }, raw: true
            });

            for (const obj of datosAdicionales.data) {
                if (obj.fk_id_file) {
                    try {
                        const foto = await filesModel.verFoto(null, obj.fk_id_file);
                        if (foto && foto.image) {
                            obj.foto = `data:${foto.type};base64,${foto.image.toString('base64')}`;
                        } else {
                            obj.foto = '';
                        }
                    } catch (e) {
                        console.warn('No se pudo cargar imagen para edición (fk_id_file):', obj.fk_id_file, e.message);
                        obj.foto = '';
                    }
                }
                if (obj.fk_id_file_izq) {
                    try {
                        const fotoIzq = await filesModel.verFoto(null, obj.fk_id_file_izq);
                        if (fotoIzq && fotoIzq.image) {
                            obj.foto_izq = `data:${fotoIzq.type};base64,${fotoIzq.image.toString('base64')}`;
                        } else {
                            obj.foto_izq = '';
                        }
                    } catch (e) {
                        console.warn('No se pudo cargar imagen izquierda para edición:', obj.fk_id_file_izq, e.message);
                        obj.foto_izq = '';
                    }
                }
            }
        }

        return res.status(200).json({
            success: true,
            componente: {
                id: comp.id_wb_pag_componente,
                tipo: tipoCompId, // ID del tipo de componente
                table_name: table_comp,
                tipo_nombre: tipo_componente,
                datos_especificos: compEspecifico, // Datos de la tabla específica
                datos_adicionales: datosAdicionales // Datos adicionales si los hay
            }
        });
    } catch (error) {
        console.error(error);
        const msg = error && error.parent && error.parent.code === '42703'
            ? 'Falta la columna en base de datos. Ejecute la migración: app/migrations/add_color_acento_components.sql'
            : (String((error && error.message) || '').includes('color_acento')
                ? 'Error de esquema (color_acento). Ejecute app/migrations/add_color_acento_components.sql'
                : 'Error');
        res.status(500).json({ success: false, error: 1, message: msg });
    }
}

async function getCompToDelete(req, res) {
    try {
        const idcomp = req.body.idcomp;
        // console.log("ID recibido para eliminar:", idcomp);

        // 1. Buscar componente general
        const comp = await paginaModel.componente.findOne({
            where: { id_wb_pag_componente: idcomp, vigente: true },
            attributes: ['fk_id_cat_wb_componente']
        });

        if (!comp) {
            return res.status(200).json({
                success: false,
                message: 'El componente no existe o ya está eliminado',
            });
        }

        // 2. Actualizar componente general
        await paginaModel.componente.update(
            { vigente: false, f_no_vigente: new Date() },
            { where: { id_wb_pag_componente: idcomp } }
        );
        // console.log("✔ Componente general actualizado a no vigente");

        // 3. Obtener tabla específica
        const tipo_comp = await paginaModel.tipoComponente.findOne({
            where: { id_cat_wb_componente: comp.fk_id_cat_wb_componente }
        });

        if (!tipo_comp) {
            return res.status(200).json({
                success: false,
                message: 'El tipo de componente no existe o no está disponible',
            });
        }

        const table_comp = tipo_comp.table_componente;
        // console.log("📌 Tabla específica del componente:", table_comp);

        // 4. Actualizar en la tabla específica
        await paginaModel[table_comp].update(
            { vigente: false, f_no_vigente: new Date() },
            { where: { fk_id_wb_pag_componente: idcomp } }
        );
        // console.log("✔ Componente específico actualizado a no vigente");

        return res.status(200).json({
            success: true,
            message: 'Componente eliminado correctamente',
        });

    } catch (error) {
        console.error("❌ Error en getCompToDelete:", error);
        res.status(500).json({ success: false, error: 1, message: 'Error interno' });
    }
}
//-----------------------------------------------------------//











//-----------------------------------------------------------//
// Funcionalidad de componentes de tipo slide
async function CreateFirstSlideComp(req, res) {
    try {
        console.log('🎯 CreateFirstSlideComp llamado');
        console.log('📦 req.body recibido:', req.body);
        
        const cy = req.body.cy;
        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);

        if (!decoded) throw new Error('Alerta en jwt en petición');
        let comparedates = utilFun.compareDates(decoded.date_comp);
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let idapp = decoded.idapp;

        let {
            dataComp, tablecomp, orden, idpag, idsec, idcol, CompSlidesId
        } = req.body;
        
        console.log('📋 Datos extraídos:', { dataComp, tablecomp, orden, idpag, idsec, idcol, CompSlidesId });

        // Validar y convertir idcol a entero
        if (idcol === '' || idcol === null || idcol === undefined) {
            return res.status(400).json({
                success: false,
                message: 'El ID de columna es requerido',
            });
        }
        idcol = parseInt(idcol, 10);
        if (isNaN(idcol)) {
            return res.status(400).json({
                success: false,
                message: 'El ID de columna debe ser un número válido',
            });
        }

        // console.log(req.body);
        // console.log(req.files);
        // return;

        const CompSlidesModelTemplate = ['wb_comp_carrousel', 'wb_comp_galeria', 'wb_comp_linea'];
        if (!CompSlidesModelTemplate.includes(tablecomp)) {
            return res.status(400).json({
                success: false,
                message: 'Componente no es de tipo slide',
            });
        }

        // Si viene del agente (chatbot), debe crearse como vigente para verse inmediatamente en el editor.
        // Si NO viene del agente, mantener el comportamiento legacy (vigente: false) para flujo "Guardar todo".
        const fromAgent = req.body.fromAgent === 'true' || req.body.fromAgent === true;
        const vigenteValue = fromAgent ? true : false;

        if (CompSlidesId && CompSlidesId !== '0') {
            return res.status(409).json({
                success: false,
                message: 'Este componente ya ha sido creado y no puede ser duplicado.',
            });
        }

        // Search type comp into wb_cat_wb_componente
        const type_comp = await paginaModel.tipoComponente.findOne({
            where: {
                id_cat_wb_componente: dataComp,
                table_componente: tablecomp,
                vigente: true
            }
        });
        if (!type_comp) {
            return res.status(200).json({
                success: false,
                message: 'El componente no existe o no está disponible',
            });
        }
        if (type_comp.table_componente !== tablecomp) {
            return res.status(200).json({
                success: false,
                message: 'El componente no coincide con la tabla especificada',
            });
        }

        // Crear wb_pag_componente (borrador: no debe mostrarse hasta "Guardar todo")
        let objPagComp = {
            fk_id_wb_pag_columna: idcol,
            fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
            wb_padding: [10, 10, 10, 10],
            vigente: vigenteValue,
            f_reg: new Date(),
            orden_visible: orden,
            fk_id_cat_wb_componente: type_comp.id_cat_wb_componente
        };
        let pagcomp = await paginaModel.componente.create({ ...objPagComp });
        if (!pagcomp || !pagcomp.id_wb_pag_componente) {
            return res.status(500).json({
                success: false,
                message: 'Error al crear el componente.',
            });
        }

        const skipFile = req.body.skipFile === 'true' || req.body.skipFile === true;
        let fileIds = [];
        // Imágenes desde el módulo (selector): IDs en req.body (fk_id_file[] o fk_id_file como array)
        let rawArr = req.body['fk_id_file[]'];
        if (rawArr == null && Array.isArray(req.body.fk_id_file)) rawArr = req.body.fk_id_file;
        if (rawArr != null) {
            const arr = Array.isArray(rawArr) ? rawArr : (typeof rawArr === 'string' ? rawArr.split(',').map(s => s.trim()) : [rawArr]);
            fileIds = arr.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
        }
        if (fileIds.length === 0 && req.files && req.files.length > 0) {
            for (const file of req.files) {
                const filename = `cdn/websites/${idapp}/${Date.now()}_${file.originalname}`;
                const blob = bucket.file(filename);
                const blobStream = blob.createWriteStream();

                await new Promise((resolve, reject) => {
                    blobStream.on("error", reject);
                    blobStream.on("finish", resolve);
                    blobStream.end(file.buffer);
                });

                let newFile = await filesModel.filesMain.create({
                    file_name: file.originalname,
                    file_type: file.mimetype,
                    file_size: file.size,
                    file_path: filename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                });

                fileIds.push(newFile.id_file);
            }
        } else if (fileIds.length === 0 && !skipFile) {
            return res.status(400).json({
                success: false,
                message: 'Error al subir el archivo.',
            });
        }
        //console.log("ID del file creado:", fileIds);

        // Crear componente principal según el tipo
        let id_pag_component_create = pagcomp.id_wb_pag_componente;
        let comp_create;

        let slide_inicial;
        let table_slides;
        const slideData = {
            titulo: req.body.titulo_slides_1 || 'Título vacío',
            texto: req.body.text_slides_1 || 'Texto vacío',
            url_link: req.body.url_slides_1 || '#',
            fk_id_wb_pagina: idpag,
            fk_id_file: fileIds,
            vigente: vigenteValue,
            f_reg: new Date(),
            f_no_vigente: null,
            orden_visible: 1,
        };

        switch (tablecomp) {
            case 'wb_comp_carrousel':
                comp_create = await paginaModel.wb_comp_carrousel.create({
                    fk_id_wb_pag_componente: id_pag_component_create,
                    fk_id_cat_type_carrousel: 2,
                    color_acento: normalizeColorAccent(req.body.color_acento),
                    vigente: vigenteValue,
                    f_reg: new Date(),
                    f_no_vigente: null
                });

                slideData.fk_id_wb_comp_carrousel = comp_create.id_wb_comp_carrousel;
                slideData.url_link = req.body.url_slides_1 || '#';
                slideData.btn_text = req.body.btn_text_slides_1 || 'Ver más';
                slideData.type_slide = 1;

                table_slides = 'wb_comp_slides_carrousel';
                slide_inicial = await paginaModel.wb_comp_slides_carrousel.create(slideData);
                //console.log("Slide inicial creado:", slide_inicial);
                break;

            case 'wb_comp_galeria':
                comp_create = await paginaModel.wb_comp_galeria.create({
                    fk_id_wb_pag_componente: id_pag_component_create,
                    vigente: vigenteValue,
                    f_reg: new Date(),
                    f_no_vigente: null
                });

                slideData.fk_id_wb_comp_galeria = comp_create.id_wb_comp_galeria;
                slideData.url_link = req.body.url_slides_1 || null;

                table_slides = 'wb_comp_slides_galeria';
                slide_inicial = await paginaModel.wb_comp_slides_galeria.create(slideData);

                break;

            case 'wb_comp_linea':
                comp_create = await paginaModel.wb_comp_linea.create({
                    fk_id_wb_pag_componente: id_pag_component_create,
                    fk_id_file: fileIds.length > 0 ? fileIds[0] : null, // Para linea solo usa el primer archivo
                    vigente: vigenteValue,
                    f_reg: new Date(),
                    f_no_vigente: null
                });

                slideData.fk_id_wb_comp_linea = comp_create.id_wb_comp_linea;
                slideData.separador = req.body.anio_slides_1;

                table_slides = 'wb_comp_slides_linea';
                slide_inicial = await paginaModel.wb_comp_slides_linea.create(slideData);

                break;
        }

        if (!comp_create) {
            await paginaModel.componente.destroy({ where: { id_wb_pag_componente: id_pag_component_create } });
            return res.status(500).json({
                success: false,
                message: 'No se puede guardar el componente, intente más tarde.',
            });
        }
        if (!slide_inicial) {
            await paginaModel.componente.destroy({ where: { id_wb_pag_componente: id_pag_component_create } });
            return res.status(500).json({
                success: false,
                message: 'Error al crear el slide inicial.',
            });
        }

        let id_comp_create = [comp_create.id_wb_comp_carrousel || comp_create.id_wb_comp_galeria || comp_create.id_wb_comp_linea];
        let id_slide_create = [slide_inicial.id_wb_comp_slides_carrousel || slide_inicial.id_wb_comp_slides_galeria || slide_inicial.id_wb_comp_slides_linea];

        // console.log("componente slide: "+id_comp_create);
        // console.log("slide inicial: "+id_slide_create);
        // console.log("tabla del slide:", table_slides);

        console.log('✅ Componente slide creado exitosamente');
        console.log('📊 Datos de respuesta:', {
            id_pag_componente: id_pag_component_create,
            componente_principal: id_comp_create,
            slide_inicial: id_slide_create,
            table_slides: table_slides,
            idpag: idpag
        });
        
        return res.status(200).json({
            success: true,
            message: 'Componente slide creado exitosamente con slide inicial.',
            data: {
                id_pag_componente: id_pag_component_create,
                componente_principal: id_comp_create,
                slide_inicial: id_slide_create,
                table_slides: table_slides,
                idpag: idpag
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error al crear componente slide' });
    }
}
async function AddSlides(req, res) {
    try {
        const cy = req.body.cy;
        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);

        if (!decoded) throw new Error('Alerta en jwt en petición');
        let comparedates = utilFun.compareDates(decoded.date_comp);
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let idapp = decoded.idapp;

        const { dataComp, comp_slide, slideId, indexSlide, tablecomp, idpag } = req.body;
        //console.log("indexSlide:", indexSlide);

        const skipFile = req.body.skipFile === 'true' || req.body.skipFile === true;
        let fileIds = [];
        let rawArrAdd = req.body['fk_id_file[]'];
        if (rawArrAdd == null && Array.isArray(req.body.fk_id_file)) rawArrAdd = req.body.fk_id_file;
        if (rawArrAdd != null) {
            const arr = Array.isArray(rawArrAdd) ? rawArrAdd : (typeof rawArrAdd === 'string' ? rawArrAdd.split(',').map(s => s.trim()) : [rawArrAdd]);
            fileIds = arr.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
        }
        if (fileIds.length === 0 && req.files && req.files.length > 0) {
            for (const file of req.files) {
                const filename = `cdn/websites/${idapp}/${Date.now()}_${file.originalname}`;
                const blob = bucket.file(filename);
                const blobStream = blob.createWriteStream();

                await new Promise((resolve, reject) => {
                    blobStream.on("error", reject);
                    blobStream.on("finish", resolve);
                    blobStream.end(file.buffer);
                });

                let newFile = await filesModel.filesMain.create({
                    file_name: file.originalname,
                    file_type: file.mimetype,
                    file_size: file.size,
                    file_path: filename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                });

                fileIds.push(newFile.id_file);
            }
        } else if (fileIds.length === 0 && !skipFile) {
            return res.status(400).json({
                success: false,
                message: 'Error al subir el archivo.',
            });
        }

        let slideData = {
            fk_id_wb_pagina: idpag,
            titulo: req.body[`titulo_slides_${indexSlide}`] || '',
            texto: req.body[`text_slides_${indexSlide}`] || '',
            fk_id_file: fileIds && fileIds.length > 0 ? fileIds : [],
            // Los slides se crean como borrador. Se vuelven vigentes con "Guardar todo" (SaveAllSlidesStatus).
            vigente: false,
            f_reg: new Date(),
            f_no_vigente: null,
            orden_visible: indexSlide
        };
        let slides;

        //console.log('🧩 tablecomp recibido:', tablecomp);
        switch (tablecomp) {
            case 'wb_comp_slides_carrousel':
                slides = await paginaModel.wb_comp_slides_carrousel.create(
                    {
                        ...slideData,
                        fk_id_wb_comp_carrousel: comp_slide,
                        url_link: req.body[`url_slides_${indexSlide}`],
                        btn_text: req.body[`text_btn_slides_${indexSlide}`],
                        type_slide: (indexSlide - 1) % 3 + 1
                    }
                );
                break;

            case 'wb_comp_slides_galeria':
                slides = await paginaModel.wb_comp_slides_galeria.create(
                    {
                        ...slideData,
                        fk_id_wb_comp_galeria: comp_slide,
                    }
                );
                break;

            case 'wb_comp_slides_linea':
                slides = await paginaModel.wb_comp_slides_linea.create(
                    {
                        ...slideData,
                        fk_id_wb_comp_linea: comp_slide,
                        separador: req.body[`anio_slides_${indexSlide}`],
                    }
                );
                break;
        }
        //console.log('📦 slides:', slides);
        //console.log('Slide insertado:', slides.toJSON());

        return res.status(200).json({
            success: true,
            message: 'Slide agregado exitosamente',
            data: {
                slideId: slides.id_wb_comp_slides_carrousel ||
                    slides.id_wb_comp_slides_galeria ||
                    slides.id_wb_comp_slides_linea,
                orden: indexSlide
            }
        });

    } catch (error) {
        console.error('Error en AddSlides:', error);
        res.status(500).json({
            success: false,
            error: 1,
            message: 'Error al agregar slide: ' + error.message
        });
    }
}
async function DeleteSlides(req, res) {
    try {
        const cy = req.body.cy;
        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);

        if (!decoded) throw new Error('Alerta en jwt en petición');
        let comparedates = utilFun.compareDates(decoded.date_comp);
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        const { tablecomp, slideId, compSlide } = req.body;
        //console.log('🗑️ Datos para eliminar slide:', { tablecomp, slideId, compSlide });

        // Validar que tablecomp sea una de las tablas de slides permitidas
        const allowedTables = ['wb_comp_slides_carrousel', 'wb_comp_slides_galeria', 'wb_comp_slides_linea'];
        if (!allowedTables.includes(tablecomp)) {
            return res.status(400).json({
                success: false,
                message: 'Tabla de slides no válida.',
            });
        }

        let slideModel;
        let whereCondition = {};

        // Determinar el modelo y condición WHERE según la tabla
        switch (tablecomp) {
            case 'wb_comp_slides_carrousel':
                slideModel = paginaModel.wb_comp_slides_carrousel;
                whereCondition = {
                    id_wb_comp_slides_carrousel: slideId,
                    fk_id_wb_comp_carrousel: compSlide
                };
                break;

            case 'wb_comp_slides_galeria':
                slideModel = paginaModel.wb_comp_slides_galeria;
                whereCondition = {
                    id_wb_comp_slides_galeria: slideId,
                    fk_id_wb_comp_galeria: compSlide
                };
                break;

            case 'wb_comp_slides_linea':
                slideModel = paginaModel.wb_comp_slides_linea;
                whereCondition = {
                    id_wb_comp_slides_linea: slideId,
                    fk_id_wb_comp_linea: compSlide
                };
                break;
        }

        if (!slideModel) {
            return res.status(400).json({
                success: false,
                message: 'Modelo de slide no encontrado.',
            });
        }

        // Buscar el slide para verificar que existe
        const slide = await slideModel.findOne({
            where: whereCondition
        });

        if (!slide) {
            return res.status(404).json({
                success: false,
                message: 'Slide no encontrado.',
            });
        }

        // Verificar que el slide esté vigente
        if (!slide.vigente) {
            return res.status(400).json({
                success: false,
                message: 'El slide ya fue eliminado anteriormente.',
            });
        }

        // Eliminación suave: marcar como no vigente
        const result = await slideModel.update(
            {
                vigente: false,
                f_no_vigente: new Date()
            },
            {
                where: whereCondition
            }
        );

        console.log('✅ Slide marcado como eliminado:', result);

        // Obtener los slides restantes vigentes para reordenar
        const activeSlides = await slideModel.findAll({
            where: {
                ...whereCondition,
                vigente: true
            },
            order: [['orden_visible', 'ASC']]
        });

        // Reordenar los slides restantes
        let orderCounter = 1;
        for (const activeSlide of activeSlides) {
            await slideModel.update(
                { orden_visible: orderCounter },
                { where: { [slideModel.primaryKeyAttribute]: activeSlide[slideModel.primaryKeyAttribute] } }
            );
            orderCounter++;
        }

        return res.status(200).json({
            success: true,
            message: 'Slide eliminado correctamente y orden actualizado.',
            data: {
                slidesRestantes: activeSlides.length,
                nuevoOrden: orderCounter - 1
            }
        });

    } catch (error) {
        console.error('❌ Error en DeleteSlides:', error);
        res.status(500).json({
            success: false,
            error: 1,
            message: 'Error al eliminar slide: ' + error.message
        });
    }
}
async function UpdateSlides(req, res) {
    try {
        const { id_pag_componente, id_comp_slide, table_comp } = req.body;
        //console.log('🔄 Datos para actualizar slide:', { id_pag_componente, id_comp_slide, table_comp });

        let updateResultComp;
        let updateSlide;
        // return;

        switch (table_comp) {
            case 'wb_comp_slides_carrousel': {
                const patchCarrousel = {
                    vigente: true,
                    f_no_vigente: null
                };
                if (Object.prototype.hasOwnProperty.call(req.body, 'color_acento')) {
                    patchCarrousel.color_acento = normalizeColorAccent(req.body.color_acento);
                }
                updateResultComp = await paginaModel.componente.update({
                    vigente: true,
                    f_no_vigente: null
                }, {
                    where: { id_wb_pag_componente: id_pag_componente }
                });
                updateSlide = await paginaModel.wb_comp_carrousel.update(patchCarrousel, {
                    where: {
                        id_wb_comp_carrousel: id_comp_slide,
                        fk_id_wb_pag_componente: id_pag_componente
                    }
                });
                await paginaModel.wb_comp_slides_carrousel.update(
                    { vigente: true, f_no_vigente: null },
                    { where: { fk_id_wb_comp_carrousel: id_comp_slide } }
                );
                break;
            }

            case 'wb_comp_slides_galeria':
                updateResultComp = await paginaModel.componente.update({
                    vigente: true,
                    f_no_vigente: null
                }, {
                    where: { id_wb_pag_componente: id_pag_componente }
                });
                updateSlide = await paginaModel.wb_comp_galeria.update({
                    vigente: true,
                    f_no_vigente: null
                }, {
                    where: {
                        id_wb_comp_galeria: id_comp_slide,
                        fk_id_wb_pag_componente: id_pag_componente
                    }
                });
                await paginaModel.wb_comp_slides_galeria.update(
                    { vigente: true, f_no_vigente: null },
                    { where: { fk_id_wb_comp_galeria: id_comp_slide } }
                );
                break;
            case 'wb_comp_slides_linea':
                updateResultComp = await paginaModel.componente.update({
                    vigente: true,
                    f_no_vigente: null
                }, {
                    where: { id_wb_pag_componente: id_pag_componente }
                });
                updateSlide = await paginaModel.wb_comp_linea.update({
                    vigente: true,
                    f_no_vigente: null
                }, {
                    where: {
                        id_wb_comp_linea: id_comp_slide,
                        fk_id_wb_pag_componente: id_pag_componente
                    }
                });
                await paginaModel.wb_comp_slides_linea.update(
                    { vigente: true, f_no_vigente: null },
                    { where: { fk_id_wb_comp_linea: id_comp_slide } }
                );
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Tipo de componente no válido',
                });
        }

        if (updateResultComp && updateSlide) {
            return res.status(200).json({
                success: true,
                message: 'Slides actualizados exitosamente.',
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'Error al actualizar slides.',
            });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error al actualizar slides' });
    }
}

async function SaveAllSlidesData(req, res) {
    try {
        const {
            id_pag_componente,
            id_comp_slide,
            table_comp,
            cy,
            slidesData,
            slidesImagesData // 👈 NUEVO
        } = req.body;

        // Parsear los datos de los slides
        const slides = JSON.parse(slidesData);

        if (!slides || slides.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No se recibieron datos de slides para actualizar'
            });
        }

        // Parsear info de imágenes (si llega)
        let imagesBySlide = {};
        if (slidesImagesData) {
            try {
                const parsedImages = (typeof slidesImagesData === 'string')
                    ? JSON.parse(slidesImagesData)
                    : slidesImagesData;

                if (Array.isArray(parsedImages)) {
                    parsedImages.forEach(item => {
                        if (item && item.id_slide) {
                            imagesBySlide[item.id_slide] = item;
                        }
                    });
                }
            } catch (errParse) {
                console.error('Error al parsear slidesImagesData:', errParse);
            }
        }

        // Si hay nuevas imágenes, necesito el idapp del JWT
        let idapp = null;
        const hayNuevasImagenes = Object.values(imagesBySlide).some(
            s => s && Array.isArray(s.nuevos) && s.nuevos.length > 0
        );

        if (hayNuevasImagenes) {
            const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);
            if (!decoded) throw new Error('Alerta en jwt en petición');
            const comparedates = utilFun.compareDates(decoded.date_comp);
            if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
            idapp = decoded.idapp;
        }

        // Determinar el modelo y campo ID según el tipo de tabla
        let slideModel;
        let idField;

        switch (table_comp) {
            case 'wb_comp_slides_carrousel':
                slideModel = paginaModel.wb_comp_slides_carrousel;
                idField = 'id_wb_comp_slides_carrousel';
                break;
            case 'wb_comp_slides_galeria':
                slideModel = paginaModel.wb_comp_slides_galeria;
                idField = 'id_wb_comp_slides_galeria';
                break;
            case 'wb_comp_slides_linea':
                slideModel = paginaModel.wb_comp_slides_linea;
                idField = 'id_wb_comp_slides_linea';
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Tipo de componente no válido'
                });
        }

        // Actualizar cada slide
        const updatePromises = slides.map(async (slide) => {
            const updateData = {
                titulo: slide.titulo,
                texto: slide.texto,
                orden_visible: slide.orden_visible
            };

            // Agregar campos opcionales según el tipo de slide
            if (table_comp === 'wb_comp_slides_carrousel') {
                updateData.btn_text = slide.btn_text;
                updateData.url_link = slide.url_link;
            } else if (table_comp === 'wb_comp_slides_linea') {
                updateData.separador = slide.separador;
            }

            // Imágenes desde el módulo (selector): si el slide trae fk_id_file, usarlo directamente
            if (slide.fk_id_file != null) {
                const ids = Array.isArray(slide.fk_id_file)
                    ? slide.fk_id_file.map(id => parseInt(id, 10)).filter(n => !isNaN(n))
                    : [parseInt(slide.fk_id_file, 10)].filter(n => !isNaN(n));
                updateData.fk_id_file = ids.length > 0 ? ids : null;
            } else {
                // 👇 Lógica legacy: manejo de imágenes por slide (base64 / eliminados)
                const imgInfo = imagesBySlide[slide.slideId];

                if (imgInfo) {
                // 1) Traer los fk_id_file actuales del slide
                let updatedFileIds = [];

                const currentSlide = await slideModel.findOne({
                    where: { [idField]: slide.slideId },
                    attributes: ['fk_id_file']
                });

                if (currentSlide && currentSlide.fk_id_file) {
                    if (Array.isArray(currentSlide.fk_id_file)) {
                        updatedFileIds = [...currentSlide.fk_id_file];
                    } else {
                        updatedFileIds = [currentSlide.fk_id_file];
                    }
                }

                // 2) Eliminar los que vengan en "eliminados" (si el front lo manda)
                if (Array.isArray(imgInfo.eliminados) && imgInfo.eliminados.length > 0) {
                    const idsToRemove = new Set(
                        imgInfo.eliminados
                            .map(e => {
                                if (e == null) return null;
                                if (typeof e === 'number' || typeof e === 'string') {
                                    return String(e);
                                }
                                // casos objeto: intenta varias propiedades típicas
                                const id =
                                    e.id_file ??
                                    e.idFile ??
                                    e.fk_id_file ??
                                    e.id ??
                                    e.id_wb_file ??
                                    e.fk_id_wb_file;
                                return id != null ? String(id) : null;
                            })
                            .filter(Boolean)
                    );

                    updatedFileIds = updatedFileIds.filter(id => !idsToRemove.has(String(id)));
                }

                // 3) Guardar nuevas imágenes y agregar sus id_file
                //    ⚠️ SOLO si NO hay imágenes marcadas como eliminadas para este slide
                if (
                    Array.isArray(imgInfo.nuevos) &&
                    imgInfo.nuevos.length > 0 &&
                    idapp &&
                    (!Array.isArray(imgInfo.eliminados) || imgInfo.eliminados.length === 0)
                ) {
                    for (const nuevo of imgInfo.nuevos) {
                        try {
                            if (!nuevo.base64) continue;

                            const base64String = nuevo.base64.includes(',')
                                ? nuevo.base64.split(',')[1]
                                : nuevo.base64;

                            const buffer = Buffer.from(base64String, 'base64');

                            const filename = `cdn/websites/${idapp}/${Date.now()}_${nuevo.nombre}`;
                            const blob = bucket.file(filename);
                            const blobStream = blob.createWriteStream();

                            await new Promise((resolve, reject) => {
                                blobStream.on("error", reject);
                                blobStream.on("finish", resolve);
                                blobStream.end(buffer);
                            });

                            const newFile = await filesModel.filesMain.create({
                                file_name: nuevo.nombre,
                                file_type: nuevo.tipo || nuevo.mimetype || 'image/jpeg',
                                file_size: nuevo.size || buffer.length,
                                file_path: filename,
                                fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                            });

                            updatedFileIds.push(newFile.id_file);
                        } catch (errImg) {
                            console.error('Error guardando imagen nueva en SaveAllSlidesData:', errImg);
                        }
                    }
                }

                // 4) Asignar el arreglo final de ids al update
                //    (si no queda nada, lo dejo en null)
                updateData.fk_id_file = updatedFileIds.length > 0 ? updatedFileIds : null;
                }
            }
            // 👆 FIN lógica imágenes

            return slideModel.update(updateData, {
                where: { [idField]: slide.slideId }
            });
        });

        // Ejecutar todas las actualizaciones
        await Promise.all(updatePromises);

        // Actualizar el estado del componente principal
        await paginaModel.componente.update({
            vigente: true,
            f_no_vigente: null
        }, {
            where: { id_wb_pag_componente: id_pag_componente }
        });

        return res.status(200).json({
            success: true,
            message: `Se actualizaron correctamente ${slides.length} slide(s)`
        });

    } catch (error) {
        console.error('Error en SaveAllSlidesData:', error);
        res.status(500).json({
            success: false,
            message: 'Error al actualizar los slides: ' + error.message
        });
    }
}

//-----------------------------------------------------------//
/** Vista modulo */
async function paginasView(req, res) {
    try {
        let paginas_registros
        res.render('../views/paginas', {
            ...req.usdata
        })

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
// Función para agregar selectores
async function editarPag(req, res) {
    try {
        // VALIDACIÓN
        let cyphval = req.query.p;

        const decoded = await promisify(jwt.verify)(cyphval, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ');

        let comparedates = utilFun.compareDates(decoded.date_comp)
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        let id_wb_pagina = decoded.id_wb_pagina;
        let idapp = decoded.idapp;
        let objapp = {};

        // Buscar app primero en el catálogo global (cargado al inicio),
        // y si no está (por ejemplo, instancias creadas después del arranque),
        // buscarla directamente en la BD principal.
        const apps = global.catalogos?.cat_apps_activas;
        if (apps != null) {
            const list = Array.isArray(apps) ? apps : Object.values(apps);
            for (const app of list) {
                if (app && app.id_sysapp === idapp) {
                    objapp = app;
                    break;
                }
            }
        }

        if (!objapp || !objapp.id_sysapp) {
            const AppsModel = require('../models/AppsModel');
            const appDb = await AppsModel.findOne({
                where: { id_sysapp: idapp, vigente: true },
                raw: true
            });
            if (appDb) {
                objapp = {
                    id_sysapp: appDb.id_sysapp,
                    sysapp_name: appDb.sysapp_name,
                    fk_id_sysapp_type: appDb.fk_id_sysapp_type,
                    app_legend: appDb.app_legend,
                    app_desc: appDb.app_desc,
                    key_sysapp: appDb.key_sysapp,
                    urluri: appDb.urluri,
                    app_favicon: appDb.app_favicon
                };
            }
        }

        if (!objapp || !objapp.id_sysapp) {
            return res.redirect("/?error=Instancia no encontrada. Verifique el catálogo de aplicaciones.");
        }
        if (!objapp.key_sysapp) {
            return res.redirect("/?error=Configuración de la instancia incompleta: falta key_sysapp. Configure la aplicación en el módulo de instancias.");
        }

        // Funcionalidad para el componente de regeneracion - tags
        const bimestres = await paginaModel.cat_bimestres.findAll();
        // Documentos de regeneración por instancia (fk_id_sysapp = idapp)
        const docs_regeneracion = await paginaModel.documento.findAll({
            attributes: ['id_wb_doc', 'nombre', 'fk_id_file',
                [Sequelize.literal(`"wb_docs"."f_reg"::DATE`), 'f_reg_date']
            ],
            where: {
                fk_id_sysapp: idapp,
                vigente: true
            },
            order: [
                ['f_reg', 'desc'],
            ],
            include: [
                {
                    attributes: ['file_name', 'file_type', 'file_path'],
                    model: filesModel.files,
                    as: 'archivodoc',
                    required: false,
                    include: [{
                        attributes: ['storage_path'],
                        model: storage_files,
                        as: 'storage',
                        required: false
                    }]
                },
                {
                    model: paginaModel.cat_tags,
                    through: { attributes: [] },
                    where: { id_cat_tag: 13 },
                    required: true
                }
            ],
            //logging: // console.log
        });
        const añosRegeneracion = await paginaModel.rel_wb_tag_doc.findAll({
            attributes: [[Sequelize.fn('DISTINCT', Sequelize.col('anio')), 'anio']],
            where: {
                fk_id_cat_tag: 13,
                vigente: true
            },
            order: [['anio', 'DESC']]
        });
        //console.log(añosRegeneracion);

        // Funcionalidad para el componente de coleccion fotografica - tags tipo imagen (fk_id_sysapp_type puede ser id_sysapp o tipo de app)
        const type_content_tag = await paginaModel.cat_wb_type_content_tag.findAll();
        const whereTagsImgs = {
            fk_id_cat_type_tag: 3, // imágenes
            vigente: true,
        };
        const orConditions = [{ fk_id_sysapp_type: null }];
        if (objapp.fk_id_sysapp_type != null) orConditions.push({ fk_id_sysapp_type: objapp.fk_id_sysapp_type });
        if (idapp != null) orConditions.push({ fk_id_sysapp_type: idapp }); // tags por instancia (como en imagenesView)
        whereTagsImgs[Op.or] = orConditions;
        const tags_imgs = await paginaModel.cat_tags.findAll({
            where: whereTagsImgs,
            order: [['tag', 'asc']]
        });

        // Funcionalidad para el componente de noticias - tags (por instancia: fk_id_sysapp_type)
        const whereTagsEntradas = {
            fk_id_cat_type_tag: 2, // entradas
            vigente: true,
        };
        if (objapp.fk_id_sysapp_type != null || idapp != null) {
            const orEntradas = [{ fk_id_sysapp_type: null }];
            if (objapp.fk_id_sysapp_type != null) orEntradas.push({ fk_id_sysapp_type: objapp.fk_id_sysapp_type });
            if (idapp != null) orEntradas.push({ fk_id_sysapp_type: idapp });
            whereTagsEntradas[Op.or] = [
                ...orEntradas
            ];
        }
        const tags = await paginaModel.cat_tags.findAll({
            where: whereTagsEntradas,
            order: [['tag', 'asc']]
        });

        // Funcionalidad para el componente de cards con tag - tags
        const cat_type_tags = await paginaModel.cat_type_tags.findAll({
            where: { vigente: true },
            order: [['id_cat_type_tag', 'ASC']]
        });
        const tags_entradas_content = await paginaModel.pagina.findAll({
            attributes: ['id_wb_pagina', 'nombre_pagina', 'fk_id_cat_type_pagina', 'fk_id_user', 'url_safe', 'publicada', 'f_publicacion',
                [Sequelize.literal(`"wb_pagina"."f_reg"::DATE`), 'f_reg_date']
            ], where: {
                fk_id_sysapp: idapp,
                fk_id_cat_type_pagina: [5],
                vigente: true,
            },
            order: [
                ['fk_id_cat_type_pagina', 'asc'],
                ['publicada', 'asc'],
                ['f_publicacion', 'desc'],
            ],
        });
        // Imágenes por instancia (fk_id_sysapp = idapp)
        const tags_images_content = await paginaModel.imagen.findAll({
            attributes: ['id_wb_img', 'nombre'],
            where: {
                fk_id_sysapp: idapp,
                vigente: true,
                nombre: { [Op.ne]: null }
            },
            include: [
                {
                    attributes: ['file_name', 'file_type', 'file_path'],
                    model: filesModel.files,
                    as: 'archivoimg',
                }
            ],
            order: [['nombre', 'ASC']]
        });
        // Categorías de documentos (cat_tags tipo documento) para tabs del acordeón.
        // Se usan categorías globales de documentos (no se filtra por instancia),
        // ya que los documentos sí se filtran por fk_id_sysapp más abajo.
        const whereCatTagsDoc = {
            fk_id_cat_type_tag: 1, // tipo: documentos
            vigente: true
        };
        const cat_tags_documento = await paginaModel.cat_tags.findAll({
            where: whereCatTagsDoc,
            attributes: ['id_cat_tag', 'tag'],
            order: [['tag', 'ASC']],
            raw: true
        });
        // Documentos por instancia (fk_id_sysapp = idapp)
        const tags_docs = await paginaModel.documento.findAll({
            attributes: ['id_wb_doc', 'nombre'],
            where: {
                fk_id_sysapp: idapp,
                vigente: true
            },
            include: [
                {
                    attributes: ['file_name', 'file_type', 'file_path'],
                    model: filesModel.files,
                    as: 'archivodoc',
                    required: false
                }
            ],
            order: [['nombre', 'ASC']]
        });

        const type_component = await paginaModel.tipoComponente.findAll({
            where: {
                vigente: true,
                id_cat_wb_componente: {
                    [Op.ne]: 18
                }
            },
            order: [['id_cat_wb_componente', 'ASC']],
            raw: true,
        });

        let objpagina = await paginaModel.pagina.getDataPaginaID(id_wb_pagina);
        objpagina = objpagina[0];

        const tipoPagActual = Number(
            objpagina?.fk_id_cat_type_pagina ?? objpagina?.dataValues?.fk_id_cat_type_pagina
        );
        const scopeEd = await getEditorPaginaScopeDetail(req.usdata.id_user, idapp);
        if (
            scopeEd &&
            Number.isFinite(tipoPagActual) &&
            isPaginaDeniedByScopeDetail(scopeEd, id_wb_pagina, tipoPagActual)
        ) {
            return res.redirect(
                '/?error=' + encodeURIComponent('Sin permiso para editar esta página en esta instancia.')
            );
        }

        for (const seccion of objpagina.secciones) {
            seccion.dataValues.saved = 1;
            seccion.dataValues.modified = 0;
            for (const columna of seccion.columnas) {
                columna.dataValues.saved = 1;
                columna.dataValues.modified = 0;
                for (const componente of columna.componentes) {

                    const idcypher = jwt.sign(
                        {
                            id_componente: componente.dataValues.id_wb_pag_componente,
                            tabla: componente.tipoComponente.dataValues.table_componente,
                            date_comp: new Date()
                        },
                        objapp.key_sysapp
                    );
                    componente.idcypher = idcypher;
                    componente.dataValues.saved = 1;
                    componente.dataValues.modified = 0;
                }
            }
        }
        if (objpagina) {
            //// console.log(objpagina.dataValues);
            const classtop = objapp.fk_id_sysapp_type === 2 ? 'top_prim' : 'top_sec';

            // -----------------------------------------------------------//
            // Detectar si esta página es un BORRADOR (tipo edición) de una página publicada.
            // Esto se usa para habilitar/deshabilitar el botón "Publicar" hasta que haya cambios.
            // -----------------------------------------------------------//
            let draftOfPublished = false;
            try {
                const relEdicion = await paginaModel.rel_wb_pag_borrador.findOne({
                    where: {
                        fk_pag_nueva: id_wb_pagina,
                        fk_id_cat_pag_tipo_borrador: 1,
                        vigente: true
                    },
                    raw: true
                });

                if (relEdicion && relEdicion.fk_pag_origen) {
                    const paginaOrigen = await paginaModel.pagina.findOne({
                        where: {
                            id_wb_pagina: relEdicion.fk_pag_origen,
                            vigente: true
                        },
                        attributes: ['id_wb_pagina', 'publicada'],
                        raw: true
                    });

                    draftOfPublished = !!(paginaOrigen && paginaOrigen.publicada === true);
                }
            } catch (e) {
                console.warn('No se pudo calcular draftOfPublished:', e.message);
            }

            const hostingInst = await HostingModel.findOne({
                where: { fk_id_sysapp: idapp },
                attributes: ['fk_id_estatus_hosting'],
                raw: true
            });
            const tieneDominio = !!(hostingInst && hostingInst.fk_id_estatus_hosting === 2);

            let previewUrlStatic;
            if (tieneDominio) {
                const staticGenerator = require('../util/staticGenerator');
                const previewBase = staticGenerator.getStaticPreviewWebPathPrefix(idapp, objapp);
                let previewRoute = '/';
                if (objpagina.url_safe != null && String(objpagina.url_safe).trim() !== '') {
                    const u = String(objpagina.url_safe).trim();
                    if (u !== '/' && u !== '') {
                        previewRoute = u.startsWith('/') ? u : '/' + u;
                    }
                }
                previewUrlStatic = `${previewBase}index.html${previewRoute === '/' ? '' : '#' + previewRoute}`;
            }

            const canvasIframeSrc = `/editarpagina?p=${encodeURIComponent(cyphval)}&canvasOnly=1`;

            if (req.query.canvasOnly === '1') {
                return res.render('../views/editpag_canvas', {
                    ...req.usdata,
                    dataapp: objapp,
                    datapagina: objpagina,
                    classtop: classtop,
                    tags: tags,
                    tags_imgs: tags_imgs,
                    tags_docs: tags_docs,
                    cat_tags_documento: cat_tags_documento || [],
                    docs_regeneracion: docs_regeneracion,
                    añosRegeneracion: añosRegeneracion,
                    cat_type_tags: cat_type_tags,
                    contag: type_content_tag,
                    idcypher: cyphval,
                    edit: 1,
                    typecomp: type_component,
                    bimestres: bimestres,
                    dataComp: type_component,
                    tags_images_content: tags_images_content,
                    tags_entradas_content: tags_entradas_content,
                    draftOfPublished: draftOfPublished,
                    tieneDominio: tieneDominio,
                    previewUrlStatic: previewUrlStatic,
                    canvasOnly: true,
                });
            }

            res.render('../views/editpag', {
                ...req.usdata,
                dataapp: objapp,
                datapagina: objpagina,
                classtop: classtop,
                tags: tags, // entradas
                tags_imgs: tags_imgs, // imágenes
                tags_docs: tags_docs,
                cat_tags_documento: cat_tags_documento || [],
                docs_regeneracion: docs_regeneracion, // documentos
                añosRegeneracion: añosRegeneracion,
                cat_type_tags: cat_type_tags, // documentos | entradas | imágenes
                contag: type_content_tag,
                idcypher: cyphval,
                edit: 1,
                typecomp: type_component,
                //buttons: buttons,
                bimestres: bimestres,
                dataComp: type_component,

                tags_images_content: tags_images_content,
                tags_entradas_content: tags_entradas_content,
                draftOfPublished: draftOfPublished,
                tieneDominio: tieneDominio,
                previewUrlStatic: previewUrlStatic,
                canvasIframeSrc: canvasIframeSrc,
            });
        } else {
            throw new Error('No se encuenta la página a editar')
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
async function GetPostContent(req, res) {
    try {
        // VALIDACIÓN
        let cyphval = req.body.cy;
        const decoded = await promisify(jwt.verify)(cyphval, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let id_wb_pagina = decoded.id_wb_pagina;

        const entrada = await paginaModel.pagina.findOne({
            where: {
                id_wb_pagina: id_wb_pagina,
                vigente: true,
            },
            include: [{
                model: filesModel.files,
                as: 'archivo',
                required: false
            }, {
                model: paginaModel.cat_tags,
                through: {
                    where: { vigente: true },
                },
                required: false
            },
            ]
        });

        //// console.log(entrada);
        res.status(200).json({ success: true, message: 'Entrada localizada', entrada: entrada });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
async function paginaPrincipalView(req, res) {
    try {
        res.render('../views/pagina_principal', {
            ...req.usdata
        })

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
async function DeletePag(req, res) {
    try {
        let cyphval = req.query.p;
        const decoded = await promisify(jwt.verify)(cyphval, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ')
        let comparedates = utilFun.compareDates(decoded.date_comp)
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        const id_wb_pagina = decoded.id_wb_pagina;
        const idapp = decoded.idapp;

        let id_user_actor = null;
        try {
            const tokenDel = req.cookies[process.env.APP_COOKIE_NAME];
            if (tokenDel) {
                const usuarioDel = jwt.verify(tokenDel, process.env.SECRET);
                id_user_actor = usuarioDel.id_user;
            }
        } catch (_) {}

        const pagAntes = await paginaModel.pagina.findOne({
            where: { id_wb_pagina, fk_id_sysapp: idapp, vigente: true },
            attributes: ['fk_id_cat_type_pagina'],
            raw: true,
        });

        const t = await dbConection.transaction();
        try {
            const now = new Date();

            // 1) Dar de baja relaciones de borrador/duplicado asociadas a esta página
            await paginaModel.rel_wb_pag_borrador.update(
                { vigente: false },
                {
                    where: {
                        vigente: true,
                        [Op.or]: [
                            { fk_pag_origen: id_wb_pagina },
                            { fk_pag_nueva: id_wb_pagina }
                        ]
                    },
                    transaction: t
                }
            );

            // 2) Dar de baja estructura (secciones/columnas/componentes) si existe
            const secciones = await paginaModel.seccion.findAll({
                where: { fk_id_wb_pagina: id_wb_pagina, vigente: true },
                attributes: ['id_wb_pag_seccion'],
                raw: true,
                transaction: t
            });
            const secIds = secciones.map(s => s.id_wb_pag_seccion);
            if (secIds.length) {
                const columnas = await paginaModel.columna.findAll({
                    where: { fk_id_wb_pag_seccion: { [Op.in]: secIds }, vigente: true },
                    attributes: ['id_wb_pag_columna'],
                    raw: true,
                    transaction: t
                });
                const colIds = columnas.map(c => c.id_wb_pag_columna);
                if (colIds.length) {
                    await paginaModel.componente.update(
                        { vigente: false, f_no_vigente: now },
                        { where: { fk_id_wb_pag_columna: { [Op.in]: colIds }, vigente: true }, transaction: t }
                    );
                    await paginaModel.columna.update(
                        { vigente: false, f_no_vigente: now },
                        { where: { id_wb_pag_columna: { [Op.in]: colIds }, vigente: true }, transaction: t }
                    );
                }
                await paginaModel.seccion.update(
                    { vigente: false, f_no_vigente: now },
                    { where: { id_wb_pag_seccion: { [Op.in]: secIds }, vigente: true }, transaction: t }
                );
            }

            // 3) Dar de baja la página (restringida por instancia para evitar cross-app)
            const [affected] = await paginaModel.pagina.update(
                { f_no_vigente: now, vigente: false },
                { where: { id_wb_pagina: id_wb_pagina, fk_id_sysapp: idapp }, transaction: t }
            );

            await t.commit();

            if (!affected) {
                return res.status(404).json({ success: false, error: 1, message: 'Página no encontrada o ya eliminada.' });
            }
            if (id_user_actor && pagAntes) {
                const td = Number(pagAntes.fk_id_cat_type_pagina);
                if (TIPOS_BITACORA_PAGINA.has(td)) {
                    void registraBitacora({
                        fk_id_user_actor: id_user_actor,
                        accion: BITACORA_ACCION.PAGINA_BAJA,
                        fk_id_sysapp: idapp,
                        id_wb_pagina,
                        fk_id_cat_type_pagina: td,
                        req,
                    });
                }
            }
            return res.status(200).json({ success: true, message: 'Página eliminada exitosamente' });
        } catch (errorTx) {
            await t.rollback();
            console.error('Error al borrar la página (tx):', errorTx);
            return res.status(500).json({ success: false, error: 1, message: 'Error al borrar la página en la base de datos' });
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

// -----------------------------------------------------------//
// Publicar / despublicar / actualizar (tipo Elementor) páginas
// update=1 + stat=1: solo regenerar HTML estático, mantener publicada (sin despublicar)

/** Contexto para auditoría en logs (publicar / actualizar HTML). */
function pubPagUserCtx(req) {
    const u = req && req.usdata;
    const fwd = req && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    return {
        id_user: u && u.id_user != null ? u.id_user : null,
        email: u && u.email ? u.email : null,
        type_user: u && u.type_user ? u.type_user : null,
        ip: fwd ? String(fwd).split(',')[0].trim() : (req && req.ip) || null,
    };
}

async function PubPag(req, res) {
    try {
        const pagina_cypher = req.query.p;
        const stat = parseInt(req.query.stat, 10);
        const updateOnly = /^(1|true|yes)$/i.test(String(req.query.update || '').trim());
        const typeQuery = req.query.t;
        console.log('[PubPag] solicitud recibida', {
            ...pubPagUserCtx(req),
            stat,
            updateOnly,
            typePaginaQuery: typeQuery,
        });
        if (!pagina_cypher || Number.isNaN(stat)) {
            return res.status(400).json({
                success: false,
                error: 1,
                message: 'Parámetros inválidos'
            });
        }

        const decoded = await promisify(jwt.verify)(pagina_cypher, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición');

        const comparedates = utilFun.compareDates(decoded.date_comp);
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        const id_wb_pagina = decoded.id_wb_pagina;
        const idapp = decoded.idapp;

        const paginaActual = await paginaModel.pagina.findOne({
            where: { id_wb_pagina: id_wb_pagina }, raw: true
        });

        if (!paginaActual) {
            return res.status(404).json({
                success: false,
                error: 1,
                message: 'Página no encontrada'
            });
        }

        console.log('[PubPag] página (estado en BD antes de actuar)', {
            id_wb_pagina,
            id_sysapp: idapp,
            nombre_pagina: paginaActual.nombre_pagina,
            url_safe: paginaActual.url_safe,
            fk_id_cat_type_pagina: paginaActual.fk_id_cat_type_pagina,
            publicada: paginaActual.publicada,
        });

        // Modo "Actualizar" (Elementor): página ya publicada, solo regenerar estático
        if (stat === 1 && updateOnly && paginaActual.publicada === true) {
            const tStart = Date.now();
            console.log('[PubPag] acción: REGENERAR_HTML (página ya publicada, sin cambiar flag publicada)', {
                id_wb_pagina,
                id_sysapp: idapp,
            });
            const staticGenerator = require('../util/staticGenerator');
            let objapp = null;
            if (global.catalogos && global.catalogos.cat_apps_activas) {
                objapp = global.catalogos.cat_apps_activas.find(app => app.id_sysapp === idapp);
            }
            if (!objapp) {
                console.error('[PubPag] App no encontrada en catálogo, idapp:', idapp);
                return res.status(500).json({ success: false, error: 1, message: 'App no encontrada' });
            }
            const paginaCompleta = await paginaModel.pagina.findOne({
                where: { id_wb_pagina: id_wb_pagina },
                raw: true
            });
            if (!paginaCompleta) {
                console.error('[PubPag] Página no encontrada, id_wb_pagina:', id_wb_pagina);
                return res.status(404).json({ success: false, error: 1, message: 'Página no encontrada' });
            }
            const typePagina = Number(paginaCompleta.fk_id_cat_type_pagina) || 2;
            const distBase = staticGenerator.getDistDirBase(objapp.id_sysapp, objapp);
            const appSubdir = `app_${objapp.id_sysapp}`;
            console.log('[PubPag] regenerando HTML estático…', {
                id_wb_pagina,
                nombre_pagina: paginaCompleta.nombre_pagina,
                url_safe: paginaCompleta.url_safe,
                typePagina,
                distBase,
                appSubdir,
            });
            await staticGenerator.generateAndSaveStaticHTML(
                objapp,
                paginaCompleta,
                paginaCompleta.url_safe || '/',
                typePagina
            );
            if (typePagina === 5) {
                try {
                    console.log('[PubPag] regenerando estáticos de entrada (detalle + listado)', {
                        id_wb_pagina,
                        url_safe: paginaCompleta.url_safe,
                    });
                    await staticGenerator.generateAndSaveStaticHTMLForEntradaDetalle(objapp, paginaCompleta.id_wb_pagina, paginaCompleta.url_safe);
                    await staticGenerator.generateAndSaveStaticHTMLForEntradasList(objapp);
                    console.log('[PubPag] estáticos de entrada (detalle + listado) listos');
                } catch (e) {
                    console.error('[PubPag] Error actualizando estáticos de entradas:', e);
                }
            }
            console.log('[PubPag] REGENERAR_HTML completado', {
                id_wb_pagina,
                url_safe: paginaCompleta.url_safe,
                durationMs: Date.now() - tStart,
                distBase,
                usuario: pubPagUserCtx(req),
            });
            return res.status(200).json({ success: true, message: 'Página actualizada exitosamente' });
        }

        const pubval = stat === 1 ? false : true;
        const type_principal = paginaActual.fk_id_cat_type_pagina;

        console.log('[PubPag] acción solicitada (cambio de visibilidad / primera publicación)', {
            id_wb_pagina,
            id_sysapp: idapp,
            pubval,
            descripcion: pubval ? 'PUBLICAR u ocultar→publicar' : 'DESPUBLICAR (borrador)',
            fk_id_cat_type_pagina: type_principal,
        });

        if (pubval) {
            const HostingModel = require('../models/HostingModel');
            const hosting = await HostingModel.findOne({
                where: { fk_id_sysapp: idapp, fk_id_estatus_hosting: 2 }
            });
            if (!hosting) {
                return res.status(400).json({
                    success: false,
                    error: 1,
                    message: 'No se puede publicar: la instancia no tiene dominio asignado. Solicite el dominio al área de Infraestructura Tecnológica.'
                });
            }
        }

        if (type_principal === 1 && pubval === true) {
            await paginaModel.pagina.update(
                { publicada: false },
                {
                    where: {
                        fk_id_sysapp: idapp,
                        fk_id_cat_type_pagina: 1,
                        vigente: true,
                        id_wb_pagina: { [Op.ne]: id_wb_pagina }
                    }
                }
            );
        }

        await paginaModel.pagina.update(
            { publicada: pubval },
            { where: { id_wb_pagina: id_wb_pagina } }
        );
        console.log('[PubPag] flag publicada actualizado en BD', { id_wb_pagina, publicada: pubval });

        try {
            const staticGenerator = require('../util/staticGenerator');
            let objapp = null;
            if (global.catalogos && global.catalogos.cat_apps_activas) {
                objapp = global.catalogos.cat_apps_activas.find(app => app.id_sysapp === idapp);
            }
            if (!objapp) {
                console.error('[PubPag] No se encontró la aplicación en el catálogo, idapp:', idapp);
            } else {
                const paginaCompleta = await paginaModel.pagina.findOne({
                    where: { id_wb_pagina: id_wb_pagina },
                    raw: true
                });
                if (paginaCompleta) {
            const typePagina = Number(paginaCompleta.fk_id_cat_type_pagina) || 2;
                    if (pubval) {
                        const tPub = Date.now();
                        const distBase = staticGenerator.getDistDirBase(objapp.id_sysapp, objapp);
                        console.log('[PubPag] PUBLICAR: generando HTML estático…', {
                            id_wb_pagina,
                            nombre_pagina: paginaCompleta.nombre_pagina,
                            url_safe: paginaCompleta.url_safe,
                            typePagina,
                            distBase,
                            appSubdir: `app_${objapp.id_sysapp}`,
                        });
                        await staticGenerator.generateAndSaveStaticHTML(
                            objapp,
                            paginaCompleta,
                            paginaCompleta.url_safe || '/',
                            typePagina
                        );
                        if (typePagina === 5) {
                            try {
                                console.log('[PubPag] PUBLICAR: estáticos de entrada (detalle + listado)', { id_wb_pagina });
                                await staticGenerator.generateAndSaveStaticHTMLForEntradaDetalle(
                                    objapp,
                                    paginaCompleta.id_wb_pagina,
                                    paginaCompleta.url_safe
                                );
                                await staticGenerator.generateAndSaveStaticHTMLForEntradasList(objapp);
                            } catch (e) {
                                console.error('[PubPag] Error generando estáticos de entradas:', e);
                            }
                        }
                        console.log('[PubPag] PUBLICAR completado', {
                            id_wb_pagina,
                            url_safe: paginaCompleta.url_safe,
                            durationMs: Date.now() - tPub,
                            distBase,
                            usuario: pubPagUserCtx(req),
                        });
                    } else {
                        const tUn = Date.now();
                        const distBase = staticGenerator.getDistDirBase(objapp.id_sysapp, objapp);
                        console.log('[PubPag] DESPUBLICAR: eliminando HTML estático…', {
                            id_wb_pagina,
                            url_safe: paginaCompleta.url_safe,
                            typePagina,
                            distBase,
                        });
                        await staticGenerator.deleteStaticHTML(
                            objapp,
                            paginaCompleta,
                            paginaCompleta.url_safe || '/'
                        );
                        if (typePagina === 5) {
                            try {
                                await staticGenerator.deleteStaticHTMLVirtual(objapp, 'entrada_' + paginaCompleta.id_wb_pagina);
                                await staticGenerator.generateAndSaveStaticHTMLForEntradasList(objapp);
                            } catch (e) {
                                console.error('[PubPag] Error actualizando estáticos de entradas tras despublicar:', e);
                            }
                        }
                        console.log('[PubPag] DESPUBLICAR completado', {
                            id_wb_pagina,
                            durationMs: Date.now() - tUn,
                            distBase,
                            usuario: pubPagUserCtx(req),
                        });
                    }
                }
            }
        } catch (staticError) {
            console.error('[PubPag] Error generando/eliminando HTML estático:', {
                id_wb_pagina,
                id_sysapp: idapp,
                err: staticError && staticError.message ? staticError.message : staticError,
            });
            console.error(staticError);
        }

        return res.status(200).json({
            success: true,
            message: 'Página actualizada exitosamente'
        });

    } catch (error) {
        console.error('[PubPag] error no controlado:', {
            ...pubPagUserCtx(req),
            err: error && error.message ? error.message : error,
        });
        console.error(error);
        return res.status(500).json({
            success: false,
            error: 1,
            message: 'Error al actualizar la página en la base de datos'
        });
    }
}

async function consultarURL(req, res) {
    try {
        const { idpagcy, entrada } = req.body;
        const datosDecodificados = await utilFun.decodificarDatos(idpagcy);

        let objapp = [];
        Object.values(global.catalogos.cat_apps_activas).forEach(app => {
            if (app.id_sysapp === datosDecodificados.idapp) {
                objapp = app;
            }
        });

        if (!objapp) return res.status(500).json({ url: null, success: false, message: 'JWT invalido!' });

        if (entrada) {
            let relTagPag = await paginaModel.rel_wb_tag_pagina.findOne({
                where: {
                    fk_id_wb_pagina: datosDecodificados.id_wb_pagina,
                }
            });

            let urlFinal = jwt.sign(
                {
                    idapp: datosDecodificados.idapp,
                    id_wb_pagina: datosDecodificados.id_wb_pagina,
                    id_tag: relTagPag ? relTagPag.fk_id_cat_tag : null,
                    date_comp: new Date()
                },
                process.env.SECRET
            );

            urlFinal = `detalle?d=${urlFinal}`;
            return res.status(200).json({ url: urlFinal, success: true, message: 'Correcto!' });
        }

        let finalUrl = '';
        if (objapp.urluri.startsWith('https://')) {
            finalUrl = objapp.urluri;
        } else {
            finalUrl = 'https://' + objapp.urluri;
        }

        // Buscar la página por ID
        const paginaActual = await paginaModel.pagina.findOne({
            where: { id_wb_pagina: datosDecodificados.id_wb_pagina }
        });

        if (!paginaActual) {
            return res.status(404).json({ url: null, success: false, message: 'Página no encontrada en la aplicación.' });
        }

        /**
         * Obtiene la cadena de rutas (url_safe) dinámica según el tipo de página.
         * Soporta jerarquías de tipo 5 -> 2 -> 1 y variantes, de forma dinámica según el catálogo de tipos.
         */
        function getTipoPaginaCatalogoAndOrden() {
            const tipoPaginaCatalogo = global.catalogos?.cat_tipo_pags
                ? Object.fromEntries(global.catalogos.cat_tipo_pags.map(x => [x.id_tipo_pags, x.nombre]))
                : { 1: 'raiz', 2: 'seccion', 5: 'detalle' };
            const ordenJerarquico = Object.keys(tipoPaginaCatalogo)
                .map(tipo => parseInt(tipo, 10))
                .sort((a, b) => a - b);
            return { tipoPaginaCatalogo, ordenJerarquico };
        }

        // Construye el mapa de tipoSuperior para jerarquía
        function getTipoSuperiorMap(ordenJerarquico) {
            const tipoSuperior = {};
            for (let i = 1; i < ordenJerarquico.length; i++) {
                tipoSuperior[ordenJerarquico[i]] = ordenJerarquico[i - 1];
            }
            return tipoSuperior;
        }

        // Busca página raíz preferente (url_safe === "/") entre una lista
        function encontrarPaginaRaizPreferida(paginasRaiz) {
            let preferido = paginasRaiz.find(p => (p.url_safe || '').trim() === '/');
            return preferido ? preferido : (paginasRaiz.length > 0 ? paginasRaiz[0] : null);
        }

        // Lógica principal para obtener la cadena rutas de una página
        async function obtenerCadenaRutas(pagina) {
            const cadenaRutas = [];
            let paginaActual = pagina;

            const { tipoPaginaCatalogo, ordenJerarquico } = getTipoPaginaCatalogoAndOrden();
            const tipoSuperior = getTipoSuperiorMap(ordenJerarquico);

            const paginasRevisadas = new Set();

            let tipoActual = paginaActual.fk_id_cat_type_pagina;

            // Siempre se agrega la URL de la propia página al principio
            cadenaRutas.unshift(paginaActual.url_safe || '');
            paginasRevisadas.add(paginaActual.id_wb_pagina);
            // ------------- Caso: raíz (tipo 1) -----------------
            if (tipoActual === 1) {
                const paginasRaiz = await paginaModel.pagina.findAll({
                    where: {
                        fk_id_sysapp: paginaActual.fk_id_sysapp,
                        fk_id_cat_type_pagina: 1,
                        publicada: true,
                        vigente: true
                    }
                });
                const preferido = encontrarPaginaRaizPreferida(paginasRaiz);
                if (preferido) cadenaRutas[0] = preferido.url_safe || '';
                return cadenaRutas;
            }
            // ------------- Caso: sección (tipo 2) -------------
            if (tipoActual === 2) {
                const paginasRaiz = await paginaModel.pagina.findAll({
                    where: {
                        fk_id_sysapp: paginaActual.fk_id_sysapp,
                        fk_id_cat_type_pagina: ordenJerarquico[0], // tipo 1
                        publicada: true,
                        vigente: true
                    }
                });
                const preferido = encontrarPaginaRaizPreferida(paginasRaiz);
                if (preferido) {
                    cadenaRutas.unshift(preferido.url_safe || '');
                }
                return cadenaRutas;
            }
            // ------------- Caso: detalle u otro tipo -------------
            let tipoABuscar = tipoSuperior[tipoActual];
            let fk_id_padre_pagina = paginaActual.fk_id_padre_pagina;
            let id_sysapp = paginaActual.fk_id_sysapp;

            while (tipoABuscar !== undefined) {
                let paginaPadre = null;
                // Si hay padre explícito, búscalo por id
                if (fk_id_padre_pagina) {
                    paginaPadre = await paginaModel.pagina.findOne({
                        where: {
                            id_wb_pagina: fk_id_padre_pagina,
                            fk_id_cat_type_pagina: tipoABuscar,
                            publicada: true,
                            vigente: true
                        }
                    });
                }
                // Si no hay o no corresponde el padre, buscar por sysapp/tipo
                if (!paginaPadre) {
                    if (tipoABuscar === 1) {
                        const paginasRaiz = await paginaModel.pagina.findAll({
                            where: {
                                fk_id_sysapp: id_sysapp,
                                fk_id_cat_type_pagina: 1,
                                publicada: true,
                                vigente: true
                            }
                        });
                        paginaPadre = encontrarPaginaRaizPreferida(paginasRaiz);
                    } else {
                        paginaPadre = await paginaModel.pagina.findOne({
                            where: {
                                fk_id_sysapp: id_sysapp,
                                fk_id_cat_type_pagina: tipoABuscar,
                                publicada: true,
                                vigente: true
                            }
                        });
                    }
                }

                if (paginaPadre && !paginasRevisadas.has(paginaPadre.id_wb_pagina)) {
                    cadenaRutas.unshift(paginaPadre.url_safe || '');
                    paginasRevisadas.add(paginaPadre.id_wb_pagina);
                    tipoABuscar = tipoSuperior[tipoABuscar];
                    fk_id_padre_pagina = paginaPadre.fk_id_padre_pagina;
                } else {
                    break;
                }
            }
            return cadenaRutas;
        }

        function limpiarYFormatearFragmentos(fragmentos) {
            return fragmentos
                .map((frag, idx) => {
                    if (typeof frag !== 'string') return '';
                    frag = frag.trim();
                    if (idx === 0 && frag === '/') return '';
                    return frag.replace(/^\/+|\/+$/g, '');
                })
                .filter(frag => frag.length > 0);
        }

        function unirRutaFragmentos(fragmentosLimpios) {
            let rutaCompleta = '/' + fragmentosLimpios.join('/');
            if (rutaCompleta === '/' && fragmentosLimpios.length === 0) rutaCompleta = '/';
            return rutaCompleta;
        }

        // Generar la URL basada en la jerarquía de páginas
        const fragmentosRuta = await obtenerCadenaRutas(paginaActual);
        const fragmentosLimpios = limpiarYFormatearFragmentos(fragmentosRuta);
        let rutaCompleta = unirRutaFragmentos(fragmentosLimpios);
        const urlFinal = `${finalUrl}${rutaCompleta}`;
        return res.status(200).json({ url: urlFinal, success: true, message: 'Correcto!' });
    } catch (error) {
        console.error("⚠️ [CONSULTAR_URL_ERROR]: ", error);
        return res.status(500).json({ url: null, error: error, success: false });
    }
};

async function updateComponentData(req, res) {
    try {
        // AHORA también recibimos datosColecciones (solo tipo 24)
        const { datosExtras, datosForm, datosColecciones } = req.body;
        const { id_comp, tipo: dataComp, cy, idpag, tablecomp, idapp } = JSON.parse(datosExtras);
        let formulario = JSON.parse(datosForm);

        const decoded = await promisify(jwt.verify)(cy, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición');
        let comparedates = utilFun.compareDates(decoded.date_comp);
        if (!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");

        // Search type comp into wb_cat_wb_componente
        const type_comp = await paginaModel.tipoComponente.findOne({
            where: {
                id_cat_wb_componente: dataComp,
                table_componente: tablecomp,
                vigente: true
            }
        });

        if (!type_comp) {
            return res.status(200).json({
                success: false,
                message: 'El componente no existe o no está disponible',
            });
        }

        const busquedaJsonImages = (() => {
            const keys = Object.keys(formulario || {});
            if (keys.some(k => k === 'images' || k === 'images_izq')) return true;
            return Object.values(formulario || {}).some(v => {
                if (Object.prototype.hasOwnProperty.call(v, 'images')) return true;
                return Object.values(v).some(x => typeof x === 'string' && x.includes('images'));
            });
        })();

        // Normalizar formulario: si viene como array de objetos [{k:v}, ...] unir en uno
        if (Array.isArray(formulario)) {
            formulario = formulario.reduce(
                (acc, cur) =>
                    (cur && typeof cur === 'object' && !Array.isArray(cur))
                        ? Object.assign(acc, cur)
                        : acc,
                {}
            );
        }

        if (busquedaJsonImages) {
            let imagesFiles = [];
            if (req.files) {
                if (Array.isArray(req.files)) {
                    imagesFiles = req.files.filter(f => f.fieldname === 'images');
                } else if (req.files.images) {
                    imagesFiles = Array.isArray(req.files.images) ? req.files.images : [req.files.images];
                } else {
                    for (const k in req.files) {
                        const v = req.files[k];
                        if (Array.isArray(v)) {
                            imagesFiles.push(...v.filter(f => f.fieldname === 'images' || k === 'images'));
                        } else if (v && v.fieldname === 'images') {
                            imagesFiles.push(v);
                        }
                    }
                }
            }

            if (imagesFiles.length > 0) {
                const file = imagesFiles[0];
                const filename = `cdn/websites/${idapp}/${file.originalname}`;
                const blob = bucket.file(filename);
                const blobStream = blob.createWriteStream();
                await new Promise((resolve, reject) => {
                    blobStream.on("error", reject);
                    blobStream.on("finish", resolve);
                    blobStream.end(file.buffer);
                });

                let newFile = await filesModel.filesMain.create({
                    file_name: file.originalname,
                    file_type: file.mimetype,
                    file_size: file.size,
                    file_path: filename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                });

                formulario.fk_id_file = newFile.id_file;
                console.log("ID del file creado (imagen derecha):", formulario.fk_id_file);
            } else if (formulario.images === 'image_changed' || formulario.images === 'images') {
                return res.status(400).json({ success: false, message: 'No hay archivos images.' });
            }

            // Imagen izquierda del título principal (wb_comp_titulopag)
            if (tablecomp === 'wb_comp_titulopag' && req.files && Array.isArray(req.files)) {
                const fileIzq = req.files.find(f => f.fieldname === 'images_izq');
                if (fileIzq) {
                    const filenameIzq = `cdn/websites/${idapp}/${Date.now()}_${fileIzq.originalname}`;
                    const blobIzq = bucket.file(filenameIzq);
                    const blobStreamIzq = blobIzq.createWriteStream();
                    await new Promise((resolve, reject) => {
                        blobStreamIzq.on("error", reject);
                        blobStreamIzq.on("finish", resolve);
                        blobStreamIzq.end(fileIzq.buffer);
                    });

                    let newFileIzq = await filesModel.filesMain.create({
                        file_name: fileIzq.originalname,
                        file_type: fileIzq.mimetype,
                        file_size: fileIzq.size,
                        file_path: filenameIzq,
                        fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                    });

                    formulario.fk_id_file_izq = newFileIzq.id_file;
                    console.log("ID del file creado (imagen izquierda):", formulario.fk_id_file_izq);
                }
            }

            // Eliminar marcadores de file del formulario antes del update
            if (formulario && (formulario.images === 'images' || formulario.images === 'image_changed')) {
                delete formulario.images;
            }
            if (formulario && (formulario.images_izq === 'image_changed' || formulario.images_izq === 'images_izq')) {
                delete formulario.images_izq;
            }
        }

        // Título principal: si el usuario eliminó imagen(es), dejar fk en null
        if (tablecomp === 'wb_comp_titulopag') {
            if (req.body.images_removed === '1') formulario.fk_id_file = null;
            if (req.body.images_izq_removed === '1') formulario.fk_id_file_izq = null;
        }

        if (dataComp === 24) {
            let coleccionesPayload = [];
            if (datosColecciones) {
                try {
                    coleccionesPayload = JSON.parse(datosColecciones);
                } catch (e) {
                    console.error('Error parseando datosColecciones (tipo 24):', e);
                    coleccionesPayload = [];
                }
            }

            // Si no nos mandaron nada específico, consideramos que no hay cambios
            if (!Array.isArray(coleccionesPayload) || coleccionesPayload.length === 0) {
                return res.status(200).json({
                    success: true,
                    message: 'Componente actualizado correctamente.'
                });
            }

            // Cargamos las colecciones vigentes actuales de este componente
            const existentes = await paginaModel[tablecomp].findAll({
                where: {
                    fk_id_wb_pag_componente: id_comp,
                    vigente: true
                },
                order: [['id_wb_comp_coleccion_fotografica', 'ASC']]
            });

            // Mismo content_tag que usas en CreateComp para wb_comp_coleccion_fotografica
            const CONTENT_TAG_COLECCION = 3;

            for (const cambio of coleccionesPayload) {
                const idx = Number(cambio.coleccionId);
                if (Number.isNaN(idx)) continue;

                const accion = cambio.accion;
                const nuevoTag = cambio.fk_id_cat_tag
                    ? parseInt(cambio.fk_id_cat_tag, 10)
                    : null;

                // GUARDADO → crea nueva fila
                if (accion === 'guardado') {
                    if (!nuevoTag) continue;

                    await paginaModel[tablecomp].create({
                        fk_id_wb_pag_componente: id_comp,
                        fk_id_cat_tag: nuevoTag,
                        fk_id_cat_wb_type_content_tag: CONTENT_TAG_COLECCION,
                        vigente: true,
                        f_reg: new Date(),
                        f_no_vigente: null
                    });
                    continue;
                }

                // Para modificacion / eliminacion necesitamos mapear contra el arreglo existentes
                const registro = existentes[idx];
                if (!registro) {
                    // índice fuera de rango / ya no existe
                    continue;
                }

                // MODIFICACION → actualiza fk_id_cat_tag
                if (accion === 'modificacion') {
                    if (!nuevoTag) continue;

                    await registro.update({
                        fk_id_cat_tag: nuevoTag
                    });
                    continue;
                }

                // ELIMINACION → solo deshabilitar (vigente = false)
                if (accion === 'eliminacion') {
                    await registro.update({
                        vigente: false,
                        f_no_vigente: new Date()
                    });
                    continue;
                }
            }

            return res.status(200).json({
                success: true,
                message: 'Componente actualizado correctamente.'
            });
        }
        // ================== FIN LÓGICA ESPECIAL TIPO 24 ====================

        if (formulario && Object.prototype.hasOwnProperty.call(formulario, 'color_acento')) {
            formulario.color_acento = normalizeColorAccent(formulario.color_acento);
        }

        await paginaModel[tablecomp].update(formulario, {
            where: { fk_id_wb_pag_componente: id_comp }
        });

        return res.status(200).json({
            success: true,
            message: 'Componente actualizado correctamente.'
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function createComponenteAcordeon(req, res) {
    try {
        const { titulo, descripcion, acordeonId, idpag, idsec, idcol, dataComp, orden, i } = req.body;
        console.log("REQ BODY:", req.body);

        const decoded = await promisify(jwt.verify)(i, process.env.SECRET);

        if (!decoded) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }

        const compareDates = utilFun.compareDates(decoded.date_comp);
        if (!compareDates) {
            return res.status(401).json({ success: false, message: 'Token expirado' });
        }

        const idapp = decoded.idapp;
        const userId = decoded.id;

        // Validar que el título no esté vacío
        if (!titulo || titulo.trim() === '') {
            return res.status(400).json({ success: false, message: 'El título es requerido' });
        }

        // Si acordeonId existe y es > 0, es una actualización
        if (acordeonId && parseInt(acordeonId) > 0) {
            // Buscar el wb_pag_componente del acordeón
            const pagComponente = await paginaModel.componente.findOne({
                where: {
                    id_wb_pag_componente: acordeonId,
                    vigente: true
                }
            });

            if (!pagComponente) {
                return res.status(404).json({ success: false, message: 'Acordeón no encontrado' });
            }

            // Actualizar wb_pag_componente
            await paginaModel.componente.update(
                { f_ult_mod: new Date() },
                { where: { id_wb_pag_componente: acordeonId, vigente: true } }
            );

            // Buscar y actualizar en wb_contenedor_acordeon si existe
            if (paginaModel.wb_contenedor_acordeon) {
                await paginaModel.wb_contenedor_acordeon.update(
                    {
                        titulo: titulo.trim(),
                        descripcion: descripcion ? descripcion.trim() : null,
                        f_ult_mod: new Date()
                    },
                    {
                        where: {
                            fk_id_wb_pag_componente: acordeonId,
                            vigente: true
                        }
                    }
                );
            }

            return res.json({
                success: true,
                message: 'Acordeón actualizado correctamente',
                data: {
                    acordeonId: acordeonId,
                    tablecomp: 'wb_comp_acordeon'
                }
            });
        } else {
            // CREAR NUEVO ACORDEÓN - Patrón similar a CreateComp

            // Validar idcol
            if (!idcol || idcol === '' || idcol === null || idcol === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'El ID de columna es requerido'
                });
            }

            const idcolInt = parseInt(idcol, 10);
            if (isNaN(idcolInt)) {
                return res.status(400).json({
                    success: false,
                    message: 'El ID de columna debe ser un número válido'
                });
            }

            // Buscar el tipo de componente acordeón en wb_cat_wb_componente
            // dataComp debe ser el ID del tipo acordeón (ej: 25 o el que corresponda)
            const tipoComponente = await paginaModel.tipoComponente.findOne({
                where: {
                    id_cat_wb_componente: dataComp, // ID del tipo acordeón
                    vigente: true
                }
            });

            if (!tipoComponente) {
                return res.status(404).json({
                    success: false,
                    message: 'El tipo de componente acordeón no existe en el catálogo'
                });
            }

            // 1. Crear el registro en wb_pag_componente
            const nuevoPagComponente = await paginaModel.componente.create({
                fk_id_wb_pag_columna: idcolInt,
                fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                wb_padding: [10, 10, 10, 10],
                vigente: true,
                f_reg: new Date(),
                orden_visible: orden || 1,
                fk_id_cat_wb_componente: tipoComponente.id_cat_wb_componente
            });

            if (!nuevoPagComponente || !nuevoPagComponente.id_wb_pag_componente) {
                return res.status(500).json({
                    success: false,
                    message: 'Error al crear el componente base'
                });
            }

            const idPagComponente = nuevoPagComponente.id_wb_pag_componente;
            const contenedorAcordeon = await paginaModel.wb_contenedor_acordeon.create({
                fk_id_wb_pagina: idpag,
                fk_id_wb_pag_componente: idPagComponente,
                titulo: titulo.trim(),
                descripcion: descripcion ? descripcion.trim() : null,
                vigente: true,
                f_reg: new Date()
            });

            const contenedorId = contenedorAcordeon.id_wb_contenedor_acordeon;

            // Crear automáticamente una categoría con datos mínimos
            const nuevaCategoria = await paginaModel.wb_categoria_acordeon.create({
                descripcion: 'Categoría General',
                fk_id_wb_pagina: idpag,
                fk_id_wb_contenedor_acordeon: contenedorId,
                activo: true,
                f_reg: new Date()
            });

            const categoriaId = nuevaCategoria.id_wb_categoria_acordeon;

            // Crear automáticamente una subcategoría dentro de la categoría creada
            const nuevaSubcategoria = await paginaModel.rel_wb_subcategoria.create({
                titulo: 'Subcategoría General',
                fk_id_wb_categoria_acordeon: categoriaId,
                fk_id_wb_pagina: idpag,
                fk_id_wb_contenedor_acordeon: contenedorId,
                vigente: true,
                f_reg: new Date()
            });

            return res.json({
                success: true,
                message: 'Acordeón creado correctamente con categoría y subcategoría por defecto',
                data: {
                    acordeonId: idPagComponente,
                    componenteContenedorAcordeon: contenedorId,
                    acordeonEspecificoId: contenedorId,
                    tablecomp: 'wb_contenedor_acordeon',
                    categoriaId: categoriaId,
                    subcategoriaId: nuevaSubcategoria.id_rel_wb_subcategoria
                }
            });
        }
    } catch (error) {
        console.error('⚠️ [CREAR_COMPONENTE_ACORDEON_ERROR]:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al procesar el acordeón',
            error: error.message
        });
    }
}

async function addCategoriaAcordeon(req, res) {
    try {
        console.log("REQ BODY:", req.body);
        const { nombreCategoria, acordeonId, i, pagina, contenedor } = req.body;
        const decoded = await promisify(jwt.verify)(i, process.env.SECRET);

        if (!decoded) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }

        const compareDates = utilFun.compareDates(decoded.date_comp);
        if (!compareDates) {
            return res.status(401).json({ success: false, message: 'Token expirado' });
        }

        const userId = decoded.id;

        if (!acordeonId || parseInt(acordeonId) <= 0) {
            return res.status(400).json({ success: false, message: 'ID de acordeón inválido' });
        }

        const fk_id_cat_tag = (req.body.fk_id_cat_tag != null && req.body.fk_id_cat_tag !== '' && !isNaN(parseInt(req.body.fk_id_cat_tag, 10)))
            ? parseInt(req.body.fk_id_cat_tag, 10) : null;
        const descripcionFinal = (nombreCategoria && nombreCategoria.trim() !== '')
            ? nombreCategoria.trim()
            : (fk_id_cat_tag ? null : '');

        if (!descripcionFinal && fk_id_cat_tag == null) {
            return res.status(400).json({ success: false, message: 'Indica el nombre de la categoría o selecciona una categoría de documentos.' });
        }

        let descripcionVal = descripcionFinal;
        if (fk_id_cat_tag && !descripcionVal) {
            const tag = await paginaModel.cat_tags.findOne({ where: { id_cat_tag: fk_id_cat_tag }, attributes: ['tag'] });
            descripcionVal = tag ? tag.tag : 'Categoría';
        }

        const nuevaCategoria = await paginaModel.wb_categoria_acordeon.create({
            descripcion: descripcionVal || 'Categoría',
            fk_id_cat_tag: fk_id_cat_tag,
            fk_id_wb_pagina: pagina,
            fk_id_wb_contenedor_acordeon: contenedor,
            activo: true,
            f_reg: new Date()
        });

        return res.json({
            success: true,
            message: 'Categoría agregada correctamente',
            data: {
                categoriaId: nuevaCategoria.id_wb_categoria_acordeon
            }
        });
    } catch (error) {
        console.error('⚠️ [AGREGAR_CATEGORIA_ACORDEON_ERROR]:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al agregar categoría',
            error: error.message
        });
    }
}

async function addSubcategoriaAcordeon(req, res) {
    try {
        console.log("REQ BODY SUB:", req.body);
        const { titulo, acordeonId, categoriaId, i, pagina, contenedorId } = req.body;
        const decoded = await promisify(jwt.verify)(i, process.env.SECRET);

        if (!decoded) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }

        const compareDates = utilFun.compareDates(decoded.date_comp);
        if (!compareDates) {
            return res.status(401).json({ success: false, message: 'Token expirado' });
        }

        const userId = decoded.id;

        // Validaciones
        if (!titulo || titulo.trim() === '') {
            return res.status(400).json({ success: false, message: 'El título es requerido' });
        }

        if (!acordeonId || parseInt(acordeonId) <= 0) {
            return res.status(400).json({ success: false, message: 'ID de acordeón inválido' });
        }

        if (!categoriaId || parseInt(categoriaId) <= 0) {
            return res.status(400).json({ success: false, message: 'ID de categoría inválido' });
        }

        const nuevaSubcategoria = await paginaModel.rel_wb_subcategoria.create({
            titulo: titulo.trim(),
            fk_id_wb_categoria_acordeon: categoriaId,
            fk_id_wb_pagina: pagina,
            fk_id_wb_contenedor_acordeon: contenedorId,
            vigente: true,
            f_reg: new Date()
        });

        return res.json({
            success: true,
            message: 'Subcategoría agregada correctamente',
            data: {
                subcategoriaId: nuevaSubcategoria.dataValues.id_rel_wb_subcategoria
            }
        });
    } catch (error) {
        console.error('⚠️ [AGREGAR_SUBCATEGORIA_ACORDEON_ERROR]:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al agregar subcategoría',
            error: error.message
        });
    }
}

async function addAcordeon(req, res) {
    try {
        console.log("REQ BODY:", req.body);
        const { titulo, contenido, componenteId, subcategoriaId, url_link, i } = req.body;
        const decoded = await promisify(jwt.verify)(i, process.env.SECRET);

        if (!decoded) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }

        const compareDates = utilFun.compareDates(decoded.date_comp);
        if (!compareDates) {
            return res.status(401).json({ success: false, message: 'Token expirado' });
        }

        // Validaciones
        if (!titulo || titulo.trim() === '') {
            return res.status(400).json({ success: false, message: 'El título del acordeón es requerido' });
        }

        if (!url_link || url_link.trim() === '') {
            return res.status(400).json({ success: false, message: 'La URL del archivo es obligatoria' });
        }

        if (!componenteId || parseInt(componenteId) <= 0) {
            return res.status(400).json({ success: false, message: 'ID de componente inválido' });
        }

        if (!subcategoriaId || parseInt(subcategoriaId) <= 0) {
            return res.status(400).json({ success: false, message: 'ID de subcategoría inválido' });
        }

        // Crear acordeón en wb_comp_acordeon
        const nuevoAcordeon = await paginaModel.wb_comp_acordeon.create({
            fk_id_wb_pag_componente: componenteId,
            fk_id_rel_wb_subcategoria: subcategoriaId,
            titulo: titulo.trim(),
            texto: contenido ? contenido.trim() : null,
            url_link: url_link.trim(),
            vigente: true,
            f_reg: new Date()
        });

        return res.json({
            success: true,
            message: 'Acordeón agregado correctamente',
            data: {
                acordeonId: nuevoAcordeon.dataValues.id_wb_comp_acordeon
            }
        });
    } catch (error) {
        console.error('⚠️ [AGREGAR_ACORDEON_ERROR]:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al agregar acordeón',
            error: error.message
        });
    }
}

async function getAcordeonDataToEdit(req, res) {
    try {
        const { componenteId, cy: i } = req.body;
        const decoded = await promisify(jwt.verify)(i, process.env.SECRET);

        if (!decoded) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }

        const compareDates = utilFun.compareDates(decoded.date_comp);
        if (!compareDates) {
            return res.status(401).json({ success: false, message: 'Token expirado' });
        }

        if (!componenteId || parseInt(componenteId) <= 0) {
            return res.status(400).json({ success: false, message: 'ID de componente inválido' });
        }

        // Obtener datos del contenedor
        const contenedor = await paginaModel.wb_contenedor_acordeon.findAll({
            where: {
                fk_id_wb_pag_componente: componenteId,
                vigente: true
            },
            order: [['f_reg', 'ASC']],
            raw: true
        });

        if (!contenedor || contenedor.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No se encontró el contenedor del acordeón'
            });
        }

        const contenedorData = contenedor[0];

        // Obtener categorías (con cat_tag si tienen fk_id_cat_tag)
        const categorias = await paginaModel.wb_categoria_acordeon.findAll({
            where: {
                fk_id_wb_contenedor_acordeon: contenedorData.id_wb_contenedor_acordeon,
                activo: true
            },
            order: [['f_reg', 'ASC']],
            include: [{
                model: paginaModel.cat_tags,
                as: 'cat_tag',
                required: false,
                attributes: ['id_cat_tag', 'tag']
            }],
            raw: true,
            nest: true
        });

        const categoriasPlain = categorias.map(c => {
            const { cat_tag, ...rest } = c;
            return { ...rest, fk_id_cat_tag: c.fk_id_cat_tag, cat_tag: cat_tag || null };
        });

        for (let cat of categoriasPlain) {
            const subcategorias = await paginaModel.rel_wb_subcategoria.findAll({
                where: {
                    fk_id_wb_categoria_acordeon: cat.id_wb_categoria_acordeon,
                    vigente: true
                },
                order: [['f_reg', 'ASC']],
                raw: true
            });

            cat.subcategorias = subcategorias;

            for (let sub of subcategorias) {
                const acordeonesRows = await paginaModel.wb_comp_acordeon.findAll({
                    where: {
                        fk_id_rel_wb_subcategoria: sub.id_rel_wb_subcategoria,
                        vigente: true
                    },
                    order: [['f_reg', 'ASC']],
                    include: [{
                        model: paginaModel.documento,
                        as: 'documento',
                        required: false,
                        attributes: ['id_wb_doc', 'nombre'],
                        include: [{
                            model: filesModel.files,
                            as: 'archivodoc',
                            required: false,
                            attributes: ['file_path'],
                            include: [{ model: storage_files, as: 'storage', required: false, attributes: ['storage_path'] }]
                        }]
                    }]
                });
                const acordeones = acordeonesRows.map(a => {
                    const plain = a.get ? a.get({ plain: true }) : a;
                    let link = plain.url_link || null;
                    if (plain.documento && plain.documento.archivodoc) {
                        const st = plain.documento.archivodoc.storage || {};
                        link = (st.storage_path || '') + (plain.documento.archivodoc.file_path || '');
                        if (link && !/^https?:\/\//i.test(link)) link = 'https://cdn.morena.app/' + link.replace(/^\//, '');
                    }
                    return {
                        id: plain.id_wb_comp_acordeon,
                        titulo: plain.titulo || (plain.documento ? plain.documento.nombre : ''),
                        texto: plain.texto,
                        url_link: link,
                        link: link,
                        fk_id_wb_doc: plain.fk_id_wb_doc,
                        documento: plain.documento ? { id_wb_doc: plain.documento.id_wb_doc, nombre: plain.documento.nombre } : null
                    };
                });
                sub.acordeones = acordeones;
            }
        }

        contenedorData.categorias = categoriasPlain;

        return res.json({
            success: true,
            message: 'Datos obtenidos correctamente',
            data: contenedorData
        });
    } catch (error) {
        console.error('⚠️ [OBTENER_ACORDEON_ERROR]:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener datos del acordeón',
            error: error.message
        });
    }
}

async function setSubcategoriaDocumentos(req, res) {
    try {
        const { subcategoriaId, documentoIds, i } = req.body;
        const decoded = await promisify(jwt.verify)(i, process.env.SECRET);
        if (!decoded) return res.status(401).json({ success: false, message: 'Token inválido' });
        if (!utilFun.compareDates(decoded.date_comp)) return res.status(401).json({ success: false, message: 'Token expirado' });
        if (!subcategoriaId || parseInt(subcategoriaId) <= 0) return res.status(400).json({ success: false, message: 'Subcategoría inválida' });

        const sub = await paginaModel.rel_wb_subcategoria.findOne({
            where: { id_rel_wb_subcategoria: subcategoriaId, vigente: true },
            raw: true
        });
        if (!sub) return res.status(404).json({ success: false, message: 'Subcategoría no encontrada' });

        const contenedor = await paginaModel.wb_contenedor_acordeon.findOne({
            where: { id_wb_contenedor_acordeon: sub.fk_id_wb_contenedor_acordeon },
            raw: true
        });
        if (!contenedor) return res.status(404).json({ success: false, message: 'Contenedor no encontrado' });

        const ids = Array.isArray(documentoIds) ? documentoIds.filter(d => d != null && !isNaN(parseInt(d, 10))).map(d => parseInt(d, 10)) : [];

        await paginaModel.wb_comp_acordeon.update(
            { vigente: false, f_no_vigente: new Date() },
            { where: { fk_id_rel_wb_subcategoria: subcategoriaId, vigente: true } }
        );

        for (const id_wb_doc of ids) {
            await paginaModel.wb_comp_acordeon.create({
                fk_id_wb_pag_componente: contenedor.fk_id_wb_pag_componente,
                fk_id_rel_wb_subcategoria: parseInt(subcategoriaId, 10),
                fk_id_wb_doc: id_wb_doc,
                vigente: true,
                f_reg: new Date()
            });
        }

        return res.json({ success: true, message: 'Documentos actualizados' });
    } catch (error) {
        console.error('setSubcategoriaDocumentos:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

async function deleteElementoAcordeon(req, res) {
    try {
        const { tipo, elementoId, i } = req.body;
        const decoded = await promisify(jwt.verify)(i, process.env.SECRET);

        if (!decoded) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }

        const compareDates = utilFun.compareDates(decoded.date_comp);
        if (!compareDates) {
            return res.status(401).json({ success: false, message: 'Token expirado' });
        }

        if (!elementoId || parseInt(elementoId) <= 0) {
            return res.status(400).json({ success: false, message: 'ID de elemento inválido' });
        }

        let result;
        switch (tipo) {
            case 'categoria':
                result = await paginaModel.wb_categoria_acordeon.update(
                    { activo: false, f_ult_mod: new Date() },
                    { where: { id_wb_categoria_acordeon: elementoId } }
                );
                break;
            case 'subcategoria':
                result = await paginaModel.rel_wb_subcategoria.update(
                    { vigente: false, f_no_vigente: new Date() },
                    { where: { id_rel_wb_subcategoria: elementoId } }
                );
                break;
            case 'acordeon':
                result = await paginaModel.wb_comp_acordeon.update(
                    { vigente: false, f_no_vigente: new Date() },
                    { where: { id_wb_comp_acordeon: elementoId } }
                );
                break;
            default:
                return res.status(400).json({ success: false, message: 'Tipo de elemento no válido' });
        }

        return res.json({
            success: true,
            message: `${tipo.charAt(0).toUpperCase() + tipo.slice(1)} eliminado correctamente`
        });
    } catch (error) {
        console.error('⚠️ [ELIMINAR_ELEMENTO_ACORDEON_ERROR]:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al eliminar elemento',
            error: error.message
        });
    }
}

async function publicarAcordeon(req, res) {
    try {
        const { acordeonId, i } = req.body;
        // const decoded = await promisify(jwt.verify)(i, process.env.SECRET);

        // if (!decoded) {
        //     return res.status(401).json({ success: false, message: 'Token inválido' });
        // }

        // const compareDates = utilFun.compareDates(decoded.date_comp);
        // if (!compareDates) {
        //     return res.status(401).json({ success: false, message: 'Token expirado' });
        // }

        // if (!acordeonId || parseInt(acordeonId) <= 0) {
        //     return res.status(400).json({ success: false, message: 'ID de acordeón inválido' });
        // }

        // Actualizar wb_contenedor_acordeon
        const result = await paginaModel.wb_contenedor_acordeon.update(
            {
                publicada: true,
            },
            {
                where: {
                    fk_id_wb_pag_componente: acordeonId,
                    vigente: true
                }
            }
        );

        if (result[0] === 0) {
            return res.status(404).json({ success: false, message: 'Acordeón no encontrado o ya publicado' });
        }

        return res.json({
            success: true,
            message: 'Acordeón publicado correctamente'
        });
    } catch (error) {
        console.error('⚠️ [PUBLICAR_ACORDEON_ERROR]:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al publicar acordeón',
            error: error.message
        });
    }
}

module.exports = {
    paginasView,
    paginaTags,
    paginaTagDetalle,
    paginasList,
    paginaPrincipalView,
    CreatePag,
    multer,
    editarPag,
    GetPostContent,
    DeletePag,
    PubPag,
    CreateComp,
    CreateFirstSlideComp,
    AddSlides,
    UpdateSlides,
    SaveAllSlidesData,
    DeleteSlides,
    duplicarPagina,
    getBorPag,
    getSec,
    getCol,
    deleteCol,
    deleteSec,
    reorderSec,
    paginaPruebas,
    pagRegeneracionDetalle,
    getCompDataToEdit,
    getCompToDelete,
    consultarURL,
    CreateRegeneracion,
    EditRegeneracion,
    DeleteRegeneracion,
    GetRegeneracion,
    updateComponentData,
    addCategoriaAcordeon,
    addSubcategoriaAcordeon,
    createComponenteAcordeon,
    addAcordeon,
    getAcordeonDataToEdit,
    deleteElementoAcordeon,
    publicarAcordeon,
    setSubcategoriaDocumentos,
}
