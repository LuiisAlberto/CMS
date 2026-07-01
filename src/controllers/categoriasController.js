const paginaModel = require('../models/paginasModel');
const sysappTypeModel = require('../models/sysapp_type');
const sysappModel = require('../models/AppsModel');
const dbConection = require('../config/postgressdb');
const { Op, QueryTypes } = require('sequelize');
const { cat_tags, cat_type_tags } = paginaModel;
const { encodeId, decodeId } = require('../util/idEncode');
const { getScopedInstanceSysappIds } = require('../util/instanceScope');

/** Slug -> id_cat_type_tag. Evita IDs y nombres de BD en la URL. */
const TIPO_SLUG_MAP = { documentos: 1, entradas: 2, imagenes: 3 };
const TIPO_ID_TO_SLUG = { 1: 'documentos', 2: 'entradas', 3: 'imagenes' };

/**
 * Vista del módulo Categorías (tags).
 * Lista tags por tipo y por instancia (sysapp).
 * Solo muestra instancias (sysapp) de tipo 2 y 3: prioridad sysapp_user_perm (asignadas),
 * igual que usuarios por instancia; si no hay asignación, el menú (admin global).
 */
async function categoriasView(req, res) {
    try {
        const instancias = await sysappModel.findAll({
            attributes: ['id_sysapp', 'sysapp_name', 'fk_id_sysapp_type'],
            where: {
                fk_id_sysapp_type: {
                    [Op.in]: [2, 3] // Solo instancias de tipos 2 y 3
                },
                vigente: true
            },
            order: [['sysapp_name', 'ASC']],
            raw: true
        });
        const validSysappIds = instancias.map(inst => inst.id_sysapp);
        const validSet = new Set(validSysappIds);
        const allowedSysapps = await getScopedInstanceSysappIds(req, validSet);
        console.log('Entro a categoriasView');
        console.log('[categoriasView] allowedSysapps (asignadas o menú, tipo 2/3):', allowedSysapps);
        console.log('[categoriasView] instancias (sysapp tipo 2/3):', instancias);

        // Params amigables: instancia (ID encriptado), tipo (slug). Fallback a legacy para compatibilidad.
        const instanciaParam = req.query.instancia || req.query.fk_id_sysapp_type;
        const tipoParam = req.query.tipo || req.query.fk_id_cat_type_tag;

        let fkFilter = null;
        if (instanciaParam) {
            const decoded = decodeId(instanciaParam);
            if (decoded != null && validSysappIds.includes(decoded)) {
                fkFilter = decoded;
            } else if (!isNaN(parseInt(instanciaParam, 10)) && validSysappIds.includes(parseInt(instanciaParam, 10))) {
                fkFilter = parseInt(instanciaParam, 10); // legacy: ID numérico
            }
        }
        console.log('[categoriasView] instancia param:', instanciaParam ? '(presente)' : '(vacío)', 'fkFilter:', fkFilter);

        let fkTipoFilter = null;
        if (tipoParam) {
            const slug = String(tipoParam).toLowerCase();
            if (TIPO_SLUG_MAP[slug] != null) {
                fkTipoFilter = TIPO_SLUG_MAP[slug];
            } else if (!isNaN(parseInt(tipoParam, 10)) && [1, 2, 3].includes(parseInt(tipoParam, 10))) {
                fkTipoFilter = parseInt(tipoParam, 10); // legacy
            }
        }

        // Redirigir URLs legacy a formato limpio (sin IDs ni nombres de BD en la URL)
        const usedLegacy = req.query.fk_id_sysapp_type != null || req.query.fk_id_cat_type_tag != null;
        if (usedLegacy && (fkFilter != null || fkTipoFilter != null)) {
            const cleanParams = new URLSearchParams();
            if (fkFilter != null) cleanParams.set('instancia', encodeId(fkFilter));
            if (fkTipoFilter != null) cleanParams.set('tipo', TIPO_ID_TO_SLUG[fkTipoFilter]);
            const qs = cleanParams.toString();
            return res.redirect(302, qs ? '/categorias?' + qs : '/categorias');
        }

        // Para el filtro (URL): value encriptado. Para el formulario (POST): value = id real.
        const instanciasFiltradas = instancias.filter((inst) =>
            allowedSysapps.includes(inst.id_sysapp)
        );
        const instanciaOpcionesFiltro = [
            { value: '', label: 'Todas' },
            ...instanciasFiltradas.map(inst => ({
                value: encodeId(inst.id_sysapp),
                label: inst.sysapp_name || `Instancia ${inst.id_sysapp}`
            }))
        ];
        const instanciaOpciones = [
            { value: '', label: 'Seleccione instancia' },
            ...instanciasFiltradas.map(inst => ({
                value: String(inst.id_sysapp),
                label: inst.sysapp_name || `Instancia ${inst.id_sysapp}`
            }))
        ];

        const whereTags = { vigente: true };
        if (allowedSysapps.length > 0) {
            if (fkFilter != null && allowedSysapps.includes(fkFilter)) {
                whereTags[Op.or] = [
                    { fk_id_sysapp_type: fkFilter }, // aquí fk_id_sysapp_type almacena id_sysapp
                    { fk_id_sysapp_type: null }
                ];
            } else {
                whereTags[Op.or] = allowedSysapps.map(id => ({ fk_id_sysapp_type: id })).concat({ fk_id_sysapp_type: null });
            }
        } else {
            whereTags[Op.and] = [{ id_cat_tag: -1 }];
        }

        if (fkTipoFilter != null) {
            whereTags.fk_id_cat_type_tag = fkTipoFilter;
        }

        console.log('[categoriasView] whereTags construido:', JSON.stringify(whereTags));

        const [typeTags, tagsList] = await Promise.all([
            cat_type_tags.findAll({
                where: { vigente: true },
                order: [['id_cat_type_tag', 'ASC']],
                raw: true
            }),
            cat_tags.findAll({
                where: whereTags,
                order: [['fk_id_cat_type_tag', 'ASC'], ['tag', 'ASC']],
                raw: true
            })
        ]);

        const typeMap = {};
        typeTags.forEach(t => { typeMap[t.id_cat_type_tag] = t.cat_type_tag || ''; });

        const typeMapInstancia = {};
        instancias.forEach(inst => { typeMapInstancia[inst.id_sysapp] = inst.sysapp_name || ''; });

        // typeTags con slug para el filtro (value del select)
        const typeTagsConSlug = typeTags.map(t => ({
            ...t,
            slug: TIPO_ID_TO_SLUG[t.id_cat_type_tag] || ''
        })).filter(t => t.slug);

        const instancia_selected = fkFilter != null ? encodeId(fkFilter) : '';
        const tipo_selected = fkTipoFilter != null ? (TIPO_ID_TO_SLUG[fkTipoFilter] || '') : '';
        const selected_instancia_id = fkFilter != null ? String(fkFilter) : '';

        res.render('../views/categorias', {
            ...req.usdata,
            title: 'Categorías (Tags) - CMS',
            tagsList,
            typeTags: typeTagsConSlug,
            typeMap,
            instanciaOpciones,
            instanciaOpcionesFiltro,
            allowedInstanceTypes: allowedSysapps,
            sysappTypes: instancias,
            typeMapInstancia,
            instancia_selected,
            tipo_selected,
            selected_instancia_id
        });
    } catch (error) {
        console.error('[categoriasView] Error:', error);
        res.status(500).json({ success: false, error: 1, message: 'Error al cargar categorías.' });
    }
}

/**
 * Crear nueva tag (categoría).
 * Body: tipo_tag (fk_id_cat_type_tag), tag, descripcion_tag.
 */
async function createTag(req, res) {
    try {
        const validSysapps = (await sysappModel.findAll({
            attributes: ['id_sysapp', 'fk_id_sysapp_type'],
            where: {
                fk_id_sysapp_type: { [Op.in]: [2, 3] },
                vigente: true
            },
            raw: true
        })).map(inst => inst.id_sysapp);
        const allowedSysapps = await getScopedInstanceSysappIds(req, new Set(validSysapps));

        const tipo_tag = parseInt(req.body.tipo_tag, 10);
        const tag = (req.body.tag || '').trim();
        const descripcion_tag = (req.body.descripcion_tag || '').trim();
        console.log('[createTag] body recibido:', {
            tipo_tag,
            tag,
            descripcion_tag,
            fk_id_sysapp_type_raw: req.body.fk_id_sysapp_type
        });
        console.log('[createTag] allowedSysapps:', allowedSysapps, 'validSysapps:', validSysapps);

        const errores = [];
        if (!tipo_tag || isNaN(tipo_tag)) errores.push('Seleccione un tipo de categoría.');
        if (!tag) errores.push('El nombre de la categoría es obligatorio.');

        const fk_id_sysapp = req.body.fk_id_sysapp_type != null && req.body.fk_id_sysapp_type !== ''
            ? parseInt(req.body.fk_id_sysapp_type, 10) : null;
        if (fk_id_sysapp == null || isNaN(fk_id_sysapp) || !validSysapps.includes(fk_id_sysapp)) {
            errores.push('La instancia es obligatoria. Seleccione un tipo de instancia válido.');
        } else if (!allowedSysapps.includes(fk_id_sysapp)) {
            errores.push('No tiene acceso para registrar categorías en esa instancia.');
        }
        console.log('[createTag] fk_id_sysapp (id_sysapp) parsed:', fk_id_sysapp, 'errores:', errores);

        if (errores.length) {
            return res.status(400).json({
                success: false,
                error: 1,
                message: errores.join(' ')
            });
        }

        const whereExistente = { tag, fk_id_cat_type_tag: tipo_tag, vigente: true, fk_id_sysapp_type: fk_id_sysapp };
        const existente = await cat_tags.findOne({
            where: whereExistente,
            raw: true
        });
        if (existente) {
            return res.status(400).json({
                success: false,
                error: 1,
                message: 'Ya existe una categoría con ese nombre para ese tipo en esa instancia.'
            });
        }
        await cat_tags.create({
            fk_id_cat_type_tag: tipo_tag,
            tag,
            descripcion_tag: descripcion_tag || null,
            vigente: true,
            fk_id_sysapp_type: fk_id_sysapp
        });

        return res.status(200).json({ success: true, message: 'Categoría creada correctamente.' });
    } catch (error) {
        console.error('[createTag] Error:', error);
        return res.status(500).json({ success: false, error: 1, message: 'Error al crear categoría.' });
    }
}

/**
 * Actualizar tag existente.
 * Body: id_cat_tag, tipo_tag, tag, descripcion_tag.
 */
async function updateTag(req, res) {
    try {
        const validSysapps = (await sysappModel.findAll({
            attributes: ['id_sysapp', 'fk_id_sysapp_type'],
            where: {
                fk_id_sysapp_type: { [Op.in]: [2, 3] },
                vigente: true
            },
            raw: true
        })).map(inst => inst.id_sysapp);
        const allowedSysapps = await getScopedInstanceSysappIds(req, new Set(validSysapps));

        const id_cat_tag = parseInt(req.body.id_cat_tag, 10);
        const tipo_tag = parseInt(req.body.tipo_tag, 10);
        const tag = (req.body.tag || '').trim();
        const descripcion_tag = (req.body.descripcion_tag || '').trim();
        console.log('[updateTag] body recibido:', {
            id_cat_tag,
            tipo_tag,
            tag,
            descripcion_tag,
            fk_id_sysapp_type_raw: req.body.fk_id_sysapp_type
        });
        console.log('[updateTag] allowedSysapps:', allowedSysapps, 'validSysapps:', validSysapps);

        const errores = [];
        if (!id_cat_tag || isNaN(id_cat_tag)) errores.push('ID de categoría inválido.');
        if (!tipo_tag || isNaN(tipo_tag)) errores.push('Seleccione un tipo de categoría.');
        if (!tag) errores.push('El nombre de la categoría es obligatorio.');

        const fk_id_sysapp = req.body.fk_id_sysapp_type != null && req.body.fk_id_sysapp_type !== ''
            ? parseInt(req.body.fk_id_sysapp_type, 10) : null;
        if (fk_id_sysapp == null || isNaN(fk_id_sysapp) || !validSysapps.includes(fk_id_sysapp)) {
            errores.push('La instancia es obligatoria. Seleccione un tipo de instancia válido.');
        } else if (!allowedSysapps.includes(fk_id_sysapp)) {
            errores.push('No tiene acceso para modificar categorías en esa instancia.');
        }
        console.log('[updateTag] fk_id_sysapp (id_sysapp) parsed:', fk_id_sysapp, 'errores:', errores);

        if (errores.length) {
            return res.status(400).json({
                success: false,
                error: 1,
                message: errores.join(' ')
            });
        }

        const existente = await cat_tags.findOne({
            where: { id_cat_tag: id_cat_tag, vigente: true },
            raw: true
        });
        if (!existente) {
            return res.status(404).json({
                success: false,
                error: 1,
                message: 'Categoría no encontrada.'
            });
        }
        if (existente.fk_id_sysapp_type != null && !allowedSysapps.includes(existente.fk_id_sysapp_type)) {
            return res.status(403).json({
                success: false,
                error: 1,
                message: 'No tiene acceso para modificar categorías de esa instancia.'
            });
        }

        const whereDuplicado = {
            tag,
            fk_id_cat_type_tag: tipo_tag,
            vigente: true,
            fk_id_sysapp_type: fk_id_sysapp,
            id_cat_tag: { [Op.ne]: id_cat_tag }
        };
        const duplicado = await cat_tags.findOne({
            where: whereDuplicado,
            raw: true
        });
        if (duplicado) {
            return res.status(400).json({
                success: false,
                error: 1,
                message: 'Ya existe otra categoría con ese nombre para ese tipo en esa instancia.'
            });
        }
        await cat_tags.update({
            fk_id_cat_type_tag: tipo_tag,
            tag,
            descripcion_tag: descripcion_tag || null,
            fk_id_sysapp_type: fk_id_sysapp
        }, { where: { id_cat_tag } });

        return res.status(200).json({ success: true, message: 'Categoría actualizada correctamente.' });
    } catch (error) {
        console.error('[updateTag] Error:', error);
        return res.status(500).json({ success: false, error: 1, message: 'Error al actualizar categoría.' });
    }
}

/**
 * Eliminar tag (baja lógica).
 * Body: id_cat_tag.
 */
async function deleteTag(req, res) {
    try {
        const validSysapps = (await sysappModel.findAll({
            attributes: ['id_sysapp'],
            where: {
                fk_id_sysapp_type: { [Op.in]: [2, 3] },
                vigente: true
            },
            raw: true
        })).map((inst) => inst.id_sysapp);
        const allowedSysapps = await getScopedInstanceSysappIds(req, new Set(validSysapps));
        const id_cat_tag = parseInt(req.body.id_cat_tag, 10);

        if (!id_cat_tag || isNaN(id_cat_tag)) {
            return res.status(400).json({
                success: false,
                error: 1,
                message: 'ID de categoría inválido.'
            });
        }

        const existente = await cat_tags.findOne({
            where: { id_cat_tag, vigente: true },
            raw: true
        });
        if (!existente) {
            return res.status(404).json({
                success: false,
                error: 1,
                message: 'Categoría no encontrada.'
            });
        }
        if (existente.fk_id_sysapp_type != null && !allowedSysapps.includes(existente.fk_id_sysapp_type)) {
            return res.status(403).json({
                success: false,
                error: 1,
                message: 'No tiene acceso para eliminar categorías de esa instancia.'
            });
        }

        await cat_tags.update(
            {
                vigente: false,
                f_no_vigente: new Date()
            },
            { where: { id_cat_tag } }
        );

        return res.status(200).json({ success: true, message: 'Categoría eliminada correctamente.' });
    } catch (error) {
        console.error('[deleteTag] Error:', error);
        return res.status(500).json({ success: false, error: 1, message: 'Error al eliminar categoría.' });
    }
}

/**
 * API: tags por tipo (imagenes|entradas|documentos), fk_id_sysapp_type y opcionalmente id_sysapp.
 * Para que el modal de componentes muestre siempre la lista actualizada al abrir.
 * GET /api/tags?tipo=imagenes&fk_id_sysapp_type=2
 * GET /api/tags?tipo=imagenes&id_sysapp=5  (tags de imagen por instancia)
 * GET /api/tags?tipo=documentos&incluir_todas=1  (todas las categorías documento, p. ej. acordeón)
 * GET /api/tags?tipo=entradas&incluir_todas=1   (todas las categorías de entradas; fallback en modal de componentes)
 */
async function getTagsForComponent(req, res) {
    try {
        const tipo = (req.query.tipo || '').toLowerCase();
        const fk_id_sysapp_type = req.query.fk_id_sysapp_type != null && req.query.fk_id_sysapp_type !== ''
            ? parseInt(req.query.fk_id_sysapp_type, 10) : null;
        const id_sysapp = req.query.id_sysapp != null && req.query.id_sysapp !== ''
            ? parseInt(req.query.id_sysapp, 10) : null;
        /** Documentos: misma lista que editpag (acordeón), sin filtrar por instancia */
        const incluir_todas = req.query.incluir_todas === '1';

        const tipoMap = { imagenes: 3, entradas: 2, documentos: 1 };
        const fk_id_cat_type_tag = tipoMap[tipo];
        if (fk_id_cat_type_tag == null) {
            return res.status(400).json({ success: false, message: 'Parámetro tipo debe ser imagenes, entradas o documentos.' });
        }

        const whereTags = {
            fk_id_cat_type_tag,
            vigente: true,
        };
        // incluir_todas=1: todas las categorías vigentes de ese tipo (documentos, entradas o imágenes), sin filtrar por instancia
        if (incluir_todas && (fk_id_cat_type_tag === 1 || fk_id_cat_type_tag === 2 || fk_id_cat_type_tag === 3)) {
            // (mismo criterio que documentos en acordeón; evita desplegable vacío en modal de noticias si falla el filtro por instancia)
        } else {
            const orConditions = [{ fk_id_sysapp_type: null }];
            if (fk_id_sysapp_type != null && !isNaN(fk_id_sysapp_type)) orConditions.push({ fk_id_sysapp_type });
            if (id_sysapp != null && !isNaN(id_sysapp)) orConditions.push({ fk_id_sysapp_type: id_sysapp });
            whereTags[Op.or] = orConditions;
        }

        const tags = await cat_tags.findAll({
            where: whereTags,
            attributes: ['id_cat_tag', 'tag'],
            order: [['tag', 'ASC']],
            raw: true
        });

        return res.json({ success: true, tags });
    } catch (error) {
        console.error('[getTagsForComponent] Error:', error);
        return res.status(500).json({ success: false, message: 'Error al obtener tags.' });
    }
}

module.exports = {
    categoriasView,
    createTag,
    updateTag,
    deleteTag,
    getTagsForComponent
};
