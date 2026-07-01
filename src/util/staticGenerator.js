const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ejs = require('ejs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const dbConection = require('../config/postgresMain');
const minify = require('html-minifier').minify;
const publicController = require('../controllers/publicController');
const paginaModel = require('../models/paginasModel');
const { pagina, rel_wb_tag_pagina, documento, rel_wb_tag_doc } = require('../models/paginasModel');
const menuModel = require('../models/menuModel');
const footerModel = require('../models/footerModel');
const filesModel = require('../models/files');
const storage_files = require('../models/storage_files');
const { Op, Sequelize } = require('sequelize');
const { normalizeConcatenatedMediaUrl } = require('./util');

/** Igual que publicController: evita rutas rotas al concatenar storage + file_path. */
function normalizeStaticMediaUrl(url) {
    let out = String(url || '');
    while (out.includes('/cdn/cdn/')) {
        out = out.replace(/\/cdn\/cdn\//g, '/cdn/');
    }
    return out;
}

function normalizeStaticStorageAndFilePath(storagePath, filePath) {
    const defaultStorage = 'https://cdn.morena.app';
    let storage = String(storagePath || defaultStorage).trim();
    let file = String(filePath || '').trim();
    storage = normalizeStaticMediaUrl(storage).replace(/\/+$/, '');
    file = normalizeStaticMediaUrl(file).replace(/^\/+/, '');
    if (/\/cdn$/i.test(storage) && /^cdn\//i.test(file)) {
        file = file.replace(/^cdn\//i, '');
    }
    return {
        storage_path: storage + '/',
        file_path: file
    };
}

/**
 * fk_id_file de wb_pagina vive en la misma BD que files (postgressdb).
 * filesMain (postgresMain) solo como respaldo, como en replacefile del publicController.
 */
async function buildPaginaThumbFileMap(pageFileIds) {
    const map = {};
    if (!pageFileIds.length) return map;
    const fromPagDb = await filesModel.files.findAll({
        where: { id_file: pageFileIds },
        attributes: ['id_file', 'file_path'],
        include: [{
            model: storage_files,
            as: 'storage',
            required: false,
            attributes: ['storage_path']
        }],
        raw: true,
        nest: true
    });
    fromPagDb.forEach(f => {
        const st = f.storage && f.storage.storage_path ? f.storage.storage_path : null;
        map[f.id_file] = { file_path: f.file_path || null, storage_path: st };
    });
    const missing = pageFileIds.filter(id => !map[id] || !map[id].file_path);
    if (missing.length) {
        const fromMain = await filesModel.filesMain.findAll({
            where: { id_file: missing },
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
        fromMain.forEach(f => {
            const st = f.storageM && f.storageM.storage_path ? f.storageM.storage_path : null;
            map[f.id_file] = { file_path: f.file_path || null, storage_path: st };
        });
    }
    return map;
}

const appLogoCache = new Map();

async function getInstanceLogoUrl(id_sysapp) {
    if (!id_sysapp) return '';
    if (appLogoCache.has(id_sysapp)) return appLogoCache.get(id_sysapp) || '';
    try {
        const rows = await dbConection.query(
            `SELECT (COALESCE(st.storage_path,'') || COALESCE(f.file_path,'')) AS app_logo
             FROM rel_sysapp_files r
             LEFT JOIN files f ON f.id_file = r.fk_id_file
             LEFT JOIN storage_files st ON st.id_storage = f.fk_id_storage
             WHERE r.fk_id_sysapp = :id_sysapp
               AND r.fk_id_cat_type_files = 8
               AND (r.vigente IS NOT FALSE)
             ORDER BY r.f_reg DESC
             LIMIT 1`,
            { replacements: { id_sysapp } }
        );
        const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : null;
        const raw = first && first.app_logo ? String(first.app_logo).trim() : '';
        let url = raw ? (/^https?:\/\//i.test(raw) ? raw : `https://cdn.morena.app/${raw.replace(/^\/+/, '')}`) : '';
        url = normalizeConcatenatedMediaUrl(url);
        appLogoCache.set(id_sysapp, url);
        return url;
    } catch (e) {
        console.warn('[staticGenerator] getInstanceLogoUrl error:', e.message);
        appLogoCache.set(id_sysapp, '');
        return '';
    }
}

async function enrichAppForStatic(objapp) {
    const app = { ...(objapp || {}) };
    if (!app.id_sysapp) return app;
    if (!app.app_logo || String(app.app_logo).trim() === '') {
        const resolvedLogo = await getInstanceLogoUrl(app.id_sysapp);
        if (resolvedLogo) app.app_logo = resolvedLogo;
    } else if (!/^https?:\/\//i.test(String(app.app_logo))) {
        app.app_logo = `https://cdn.morena.app/${String(app.app_logo).replace(/^\/+/, '')}`;
    }
    if (app.app_logo) {
        app.app_logo = normalizeConcatenatedMediaUrl(app.app_logo);
    }
    return app;
}

/** Ruta a vistas: desde este archivo (src/util) -> src/views. No depende de process.cwd(). */
const VIEWS_PATH = path.join(__dirname, '..', 'views');

/**
 * Slug seguro para nombre de carpeta (instancia)
 */
function slugifyInstanceName(name) {
    if (!name || typeof name !== 'string') return '';
    return String(name)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50) || '';
}

/**
 * Slug estable para nombre de archivo de página (sin .html).
 * Siempre el mismo por (pagina_uri) para sobrescribir en cada actualización.
 */
function slugifyPaginaUri(pagina_uri) {
    if (pagina_uri === '/' || pagina_uri === '' || pagina_uri == null) return 'home';
    let s = String(pagina_uri).replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-');
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\-]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 80) || 'pagina';
    return s || 'pagina';
}

/**
 * Directorio de salida para producción: {base}/app_{id_sysapp}
 * Usado por el área de Infra para servir los sitios publicados.
 * Configurable con DATA_OUTPUT_PATH en .env (ej. /data o ./app)
 */
function getDataAppDir(id_sysapp) {
    const base = process.env.DATA_OUTPUT_PATH || '/data';
    return path.join(base, `app_${id_sysapp}`);
}

/**
 * Escribe un archivo tanto en dist (pruebas) como en /data (producción)
 */
function writeToDataIfEnabled(id_sysapp, fileName, content) {
    try {
        const dataDir = getDataAppDir(id_sysapp);
        const dataPath = path.join(dataDir, fileName);
        const fileDir = path.dirname(dataPath);
        if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(dataPath, content, 'utf8');
        console.log('[staticGenerator] writeToDataIfEnabled OK:', dataPath);
    } catch (e) {
        console.warn('[staticGenerator] writeToDataIfEnabled error:', e.message);
    }
}

function deleteFromDataIfEnabled(id_sysapp, fileName) {
    try {
        const dataPath = path.join(getDataAppDir(id_sysapp), fileName);
        if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
    } catch (e) {
        console.warn('⚠️ No se pudo eliminar de /data:', e.message);
    }
}

/**
 * Directorio base para HTML estático: dist_{nombre_instancia} (ej. dist_morena)
 * La ruta base es configurable vía STATIC_HTML_DIST_BASE o DATA_OUTPUT_PATH en .env.
 * Si ninguna está definida, usa process.cwd().
 * @param {number} id_sysapp
 * @param {object} [objapp] - opcional; si no se pasa, se resuelve desde global.catalogos
 */
function getDistDirBase(id_sysapp, objapp) {
    let slug = '';
    if (objapp && (objapp.app_legend || objapp.sysapp_name)) {
        slug = slugifyInstanceName(objapp.app_legend || objapp.sysapp_name);
    }
    if (!slug && typeof global !== 'undefined' && global.catalogos && global.catalogos.cat_apps_activas) {
        const app = global.catalogos.cat_apps_activas.find(a => a.id_sysapp === id_sysapp);
        if (app) slug = slugifyInstanceName(app.app_legend || app.sysapp_name);
    }
    if (!slug) slug = `app_${id_sysapp}`;
    const basePathRaw = process.env.STATIC_HTML_DIST_BASE || process.env.DATA_OUTPUT_PATH || process.cwd();
    const basePath = path.resolve(basePathRaw);
    const distDir = path.join(basePath, `dist_${slug}`);
    const exists = fs.existsSync(distDir);
    let writable = false;
    try {
        if (exists) {
            fs.accessSync(distDir, fs.constants.W_OK);
            writable = true;
        } else {
            const parent = path.dirname(distDir);
            if (fs.existsSync(parent)) {
                fs.accessSync(parent, fs.constants.W_OK);
                writable = true;
            }
        }
    } catch (e) {
        writable = false;
    }
    console.log('[staticGenerator] getDistDirBase:', {
        id_sysapp,
        slug,
        DATA_OUTPUT_PATH: process.env.DATA_OUTPUT_PATH,
        basePathResuelto: basePath,
        distDir,
        existe: exists,
        escribible: writable
    });
    return distDir;
}

/**
 * Prefijo URL (bajo /dist) para abrir el sitio estático generado desde el CMS.
 * Debe coincidir con la carpeta de getDistDirBase (dist_{slug}/app_{id}).
 */
function getStaticPreviewWebPathPrefix(id_sysapp, objapp) {
    let slug = '';
    if (objapp && (objapp.app_legend || objapp.sysapp_name)) {
        slug = slugifyInstanceName(objapp.app_legend || objapp.sysapp_name);
    }
    if (!slug) slug = `app_${id_sysapp}`;
    return `/dist/dist_${slug}/app_${id_sysapp}/`;
}

/**
 * Genera un HTML estático completo para una página publicada
 * @param {Object} objapp - Objeto de la aplicación
 * @param {Object} objpagina - Objeto de la página
 * @param {string} pagina_uri - URI de la página
 * @param {number} type_uri - Tipo de URI (1=home, 2=página normal, 5=entrada)
 * @returns {Promise<string>} HTML estático generado
 */
async function generateStaticHTML(objapp, objpagina, pagina_uri, type_uri) {
    console.log('[staticGenerator] generateStaticHTML inicio:', { id_sysapp: objapp?.id_sysapp, id_wb_pagina: objpagina?.id_wb_pagina, pagina_uri, type_uri });
    try {
        const staticAppData = await enrichAppForStatic(objapp);
        // Pre-renderizar todos los componentes
        const componentesRenderizados = await preRenderComponentes(
            objpagina,
            objapp.id_sysapp
        );

        // Obtener menú
        const menuData = await obtenerMenuData(objapp.id_sysapp);

        // Renderizar la vista completa
        const classtop = objapp.fk_id_sysapp_type === 2 ? 'top_prim' : 'top_sec';
        
        // Pre-renderizar el menú como HTML estático (con resolución de enlaces a HTML estáticos)
        // Nota: aunque generemos el menú para enlaces estáticos, para permitir
        // que los cambios del menú se reflejen desde BD sin regenerar dist,
        // NO lo pasamos a la vista (ver header.ejs).
        const menuHTML = await renderizarMenuEstatico(menuData, pagina_uri, objapp.id_sysapp);
        
        // Pre-renderizar el footer como HTML estático
        const footerHTML = await renderizarFooterEstatico(objapp.id_sysapp);
        
        // Crear objeto de datos para la vista (tipo 5 = entrada: entradas_detalle.ejs espera objPagEntrada)
        const numericType = Number(type_uri);
        const viewData = {
            dataapp: staticAppData,
            datapagina: objpagina,
            objPagEntrada: numericType === 5 ? objpagina : undefined,
            pagina: pagina_uri,
            classtop,
            edit: 0,
            menuData: menuData,
            menuHTML: menuHTML, // Menú estático para HTML generado
            footerHTML: footerHTML, // Footer pre-renderizado
            componentesRenderizados: componentesRenderizados,
            assetsPrefix: 'assets/'
        };

        // Renderizar HTML base (los componentes ya están en viewData.componentesRenderizados)
        const viewsPath = VIEWS_PATH;
        const htmlContent = await renderStaticView(viewData, viewsPath, type_uri);

        // Procesar recursos externos e internos (incluye conversión de imágenes a base64)
        const htmlProcessed = await processResources(htmlContent, viewsPath);

        // Ofuscar JavaScript inline
        const htmlObfuscated = await obfuscateInlineJS(htmlProcessed);

        // Minificar HTML (SIN ofuscar JavaScript - rompe métodos de jQuery)
        const htmlMinified = minify(htmlObfuscated, {
            removeAttributeQuotes: true,
            collapseWhitespace: true,
            removeComments: true,
            minifyJS: false,  // ❌ DESACTIVADO - ofusca métodos de jQuery como .carousel(), .trigger(), .data()
            minifyCSS: true,
            collapseBooleanAttributes: true,
            removeRedundantAttributes: true,
            useShortDoctype: false,  // Mantener <!DOCTYPE html> completo para reconocimiento sin extensión
            removeEmptyAttributes: true,
            removeOptionalTags: true,
            removeScriptTypeAttributes: true,
            removeStyleLinkTypeAttributes: true
        });

        // Asegurar que siempre empiece con <!DOCTYPE html>
        const doctypeFixed = htmlMinified.trim().startsWith('<!DOCTYPE') || htmlMinified.trim().startsWith('<!doctype')
            ? htmlMinified
            : `<!DOCTYPE html>${htmlMinified}`;

        console.log('[staticGenerator] generateStaticHTML OK, longitud:', doctypeFixed?.length);
        return doctypeFixed;
    } catch (error) {
        console.error('[staticGenerator] Error generando HTML estático:', error);
        throw error;
    }
}

/**
 * Pre-renderiza todos los componentes de la página
 */
async function preRenderComponentes(objpagina, idapp) {
    const componentesRenderizados = {};

    for (const seccion of objpagina.secciones || []) {
        for (const columna of seccion.columnas || []) {
            for (const componente of columna.componentes || []) {
                if (!componente) continue;
                // Soportar tanto modelo Sequelize (dataValues) como objeto plano (get({ plain: true }))
                const tipoComp = componente.tipoComponente || componente.tipo_componente;
                const tabla = tipoComp?.table_componente ?? tipoComp?.dataValues?.table_componente;
                const idComp = componente.id_wb_pag_componente ?? componente.dataValues?.id_wb_pag_componente;

                if (tabla && idComp) {
                    try {
                        const compResult = await publicController.renderComponente(
                            tabla,
                            idComp,
                            idapp
                        );
                        
                        if (compResult && compResult.rend) {
                            componentesRenderizados[idComp] = compResult.rend;
                        }
                    } catch (err) {
                        console.error(`Error renderizando componente ${idComp}:`, err);
                        componentesRenderizados[idComp] = '';
                    }
                }
            }
        }
    }

    return componentesRenderizados;
}

/**
 * Obtiene los datos del menú para la aplicación
 */
async function obtenerMenuPorNivel(menu_id, fk_id_padre = null) {
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

    for (const link of hijos) {
        link.submenus = await obtenerMenuPorNivel(menu_id, link.id_wb_menu_link);
    }

    return hijos;
}

async function obtenerMenuData(idapp) {
    try {
        const menuId = await menuModel.menu.findOne({
            where: {
                fk_id_sysapp: idapp,
                vigente: true,
            },
            raw: true,
        });

        if (menuId) {
            return await obtenerMenuPorNivel(menuId.id_wb_menu, null);
        }
        return [];
    } catch (menuErr) {
        console.error('Error obteniendo menú:', menuErr);
        return [];
    }
}

/**
 * Busca el archivo HTML estático correspondiente a una página en el mapping.json
 */
function buscarHTMLEstatico(id_sysapp, id_wb_pagina = null, pagina_uri = null) {
    try {
        const distDir = getDistDirBase(id_sysapp, null);
        const appDir = path.join(distDir, `app_${id_sysapp}`);
        const mappingFile = path.join(appDir, 'mapping.json');
        
        if (!fs.existsSync(mappingFile)) {
            return null;
        }
        
        const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));

        // Buscar por id_wb_pagina y pagina_uri
        if (id_wb_pagina && pagina_uri) {
            const pageKey = `${id_wb_pagina}_${pagina_uri}`;
            if (mapping[pageKey]) {
                return mapping[pageKey].fileName;
            }
        }
        
        // Buscar solo por id_wb_pagina (puede haber múltiples páginas con el mismo id pero diferentes URIs)
        if (id_wb_pagina) {
            for (const [key, value] of Object.entries(mapping)) {
                if (value.id_wb_pagina === id_wb_pagina) {
                    return value.fileName;
                }
            }
        }
        
        // Buscar solo por pagina_uri
        if (pagina_uri) {
            for (const [key, value] of Object.entries(mapping)) {
                if (value.pagina_uri === pagina_uri) {
                    return value.fileName;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error buscando HTML estático:', error);
        return null;
    }
}

/**
 * Obtiene los datos del footer activo para la aplicación
 */
async function obtenerFooterData(id_sysapp) {
    try {
        const footerActivo = await footerModel.footer.findOne({
            where: {
                fk_id_sysapp: id_sysapp,
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

        if (!footerActivo) {
            return null;
        }

        // Ordenar enlaces
        if (footerActivo.enlaces) {
            footerActivo.enlaces.sort((a, b) => {
                const catA = (a.categoria || '').toLowerCase();
                const catB = (b.categoria || '').toLowerCase();
                if (catA !== catB) {
                    return catA.localeCompare(catB);
                }
                return (a.orden_visible || 0) - (b.orden_visible || 0);
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
                    nombre: enlace.nombre,
                    url_link: enlace.url_link
                });
            });
        }

        return {
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
    } catch (error) {
        console.error('Error obteniendo footer:', error);
        return null;
    }
}

/**
 * Escapa HTML para prevenir XSS
 */
function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

/**
 * Escapa URL para atributos href
 */
function escapeUrl(url) {
    if (!url) return '#';
    try {
        const s = String(url).trim();
        if (/^\s*javascript:/i.test(s)) {
            return s === 'javascript:void(0)' ? 'javascript:void(0)' : '#';
        }
        if (s.startsWith('mailto:') || s.startsWith('tel:')) {
            return escapeHtml(s);
        }
        if (
            s.startsWith('http://') ||
            s.startsWith('https://') ||
            s.startsWith('/') ||
            s.startsWith('#') ||
            s.startsWith('.') ||
            /\.html?$/i.test(s) ||
            /^[\w./-]+$/i.test(s)
        ) {
            return escapeHtml(s);
        }
        return '#';
    } catch (e) {
        return '#';
    }
}

/**
 * Href relativo al HTML estático (mismo directorio que index.html) para SPA y subcarpetas.
 */
function resolveStaticPageHref(paginaEncontrada, id_sysapp) {
    if (!paginaEncontrada || !id_sysapp) return 'index.html';
    const raw = paginaEncontrada.url_safe;
    const pagina_uri =
        !raw || raw === '/' || String(raw).trim() === ''
            ? '/'
            : String(raw).replace(/^\/+/, '');
    if (pagina_uri === '/') return 'index.html';
    const mapped = buscarHTMLEstatico(id_sysapp, paginaEncontrada.id_wb_pagina, pagina_uri);
    if (mapped) return String(mapped).replace(/\\/g, '/');
    return getStablePageFileName(pagina_uri).replace(/\\/g, '/');
}

/**
 * Pre-renderiza el footer como HTML estático (sin necesidad de JavaScript)
 */
async function renderizarFooterEstatico(id_sysapp) {
    try {
        const footerData = await obtenerFooterData(id_sysapp);
        
        if (!footerData) {
            return '<footer class="footerMorena" id="footer-container"><div class="contFooter row"></div></footer>';
        }

        const tieneLogo = footerData.url_logo && footerData.url_logo.trim() !== '';
        const tieneSuscripcion = footerData.texto_suscripcion && footerData.texto_suscripcion.trim() !== '';
        const tieneEnlaces = footerData.enlaces_por_categoria && Object.keys(footerData.enlaces_por_categoria).length > 0;
        const tieneContacto = (footerData.direccion_contacto && footerData.direccion_contacto.trim() !== '') ||
                             (footerData.telefono_contacto && footerData.telefono_contacto.trim() !== '') ||
                             (footerData.email_contacto && footerData.email_contacto.trim() !== '');

        let numColumnas = 0;
        if (tieneLogo || tieneSuscripcion) numColumnas++;
        if (tieneEnlaces) numColumnas++;
        if (tieneContacto) numColumnas++;

        let colSize = 'col-lg-4 col-md-4';
        if (numColumnas === 1) {
            colSize = 'col-lg-12 col-md-12';
        } else if (numColumnas === 2) {
            colSize = 'col-lg-6 col-md-6';
        }

        let html = '<footer class="footerMorena" id="footer-container"><div class="contFooter row">';

        // Columna 1: Logo y Suscripción
        if (tieneLogo || tieneSuscripcion) {
            html += `<div class="${colSize} col-sm-12">`;
            if (tieneLogo) {
                html += `<img src="${escapeUrl(footerData.url_logo)}" alt="Logo MORENA">`;
            }
            if (tieneSuscripcion) {
                html += '<h1 class="titFooter mt-2">Suscríbete</h1>';
                html += `<p class="mt-2">${escapeHtml(footerData.texto_suscripcion).replace(/\n/g, '<br>')}</p>`;
                // Formulario de suscripción comentado
                // html += '<form class="subscription-form mt-3"><input type="email" placeholder="Tu correo electrónico" required=""><button type="submit">Suscribirse</button></form>';
            }
            html += '</div>';
        }

        // Columna 2: Enlaces
        if (tieneEnlaces) {
            html += `<div class="${colSize} col-sm-12">`;
            Object.keys(footerData.enlaces_por_categoria).forEach(categoria => {
                const enlacesCategoria = footerData.enlaces_por_categoria[categoria];
                if (enlacesCategoria && enlacesCategoria.length > 0) {
                    if (categoria && categoria.trim() !== '') {
                        html += `<h1 class="titFooter mt-2">${escapeHtml(categoria)}</h1>`;
                    }
                    enlacesCategoria.forEach(enlace => {
                        if (enlace.nombre && enlace.nombre.trim() !== '') {
                            const url = escapeUrl(enlace.url_link);
                            html += `<li><a href="${url}">${escapeHtml(enlace.nombre)}</a></li>`;
                        }
                    });
                }
            });
            html += '</div>';
        }

        // Columna 3: Contacto
        if (tieneContacto) {
            html += `<div class="${colSize} col-sm-12 footerContact">`;
            html += '<h1 class="titFooter mt-2">Contacto</h1>';
            if (footerData.direccion_contacto && footerData.direccion_contacto.trim() !== '') {
                html += `<li class="d-flex"><div class="contIcon"><i class="fa-solid fa-map-marker-alt"></i></div><p>${escapeHtml(footerData.direccion_contacto).replace(/\n/g, '<br>')}</p></li>`;
            }
            if (footerData.telefono_contacto && footerData.telefono_contacto.trim() !== '') {
                html += `<li class="d-flex"><div class="contIcon"><i class="fa-solid fa-phone"></i></div><p>${escapeHtml(footerData.telefono_contacto)}</p></li>`;
            }
            if (footerData.email_contacto && footerData.email_contacto.trim() !== '') {
                html += `<li class="d-flex"><div class="contIcon"><i class="fa-solid fa-envelope"></i></div><div class="conttexto"><p>Email: ${escapeHtml(footerData.email_contacto)}</p></div></li>`;
            }
            html += '</div>';
        }

        // Copyright
        if (footerData.texto_copyright && footerData.texto_copyright.trim() !== '') {
            html += '<hr class="mt-3">';
            html += `<p class="text-center">${escapeHtml(footerData.texto_copyright)}</p>`;
        }

        html += '</div></footer>';
        return html;
    } catch (error) {
        console.error('Error renderizando footer estático:', error);
        return '<footer class="footerMorena" id="footer-container"><div class="contFooter row"></div></footer>';
    }
}

/**
 * Pre-renderiza el menú como HTML estático (sin necesidad de JavaScript)
 * Reemplaza los enlaces del menú con rutas a archivos HTML estáticos cuando existen
 */
async function renderizarMenuEstatico(menuData, paginaActual = '', id_sysapp = null) {
    if (!menuData || menuData.length === 0) {
        return '<li><ul class="submenu-imagen"><li><img src="assets/img/img-menu-responsive.png" alt="Menú Imagen"></li></ul></li>';
    }

    async function obtenerAtributosLink(item, isToggle) {
        let href = '#';
        let classes = '';
        let dataTarget = '';
        const nivel = Number(item.link_nivel);
        
        // id_cat_type_link: 1 = interno, 2 = externo. Externo → url_link
        if (item.id_cat_type_link === 2 && (item.url_link || '').trim()) {
            href = (item.url_link || '').trim();
        }
        // Si tiene fk_id_wb_pagina (página interna), resolver ruta de la página de esta instancia
        else if (item.fk_id_wb_pagina && id_sysapp) {
            try {
                // Buscar la página en la BD para obtener su url_safe (incluso si no está publicada)
                const paginaEncontrada = await pagina.findOne({
                    where: {
                        id_wb_pagina: item.fk_id_wb_pagina,
                        fk_id_sysapp: id_sysapp,
                        vigente: true
                        // Removido publicada: true para que siempre encuentre la página y pueda generar el enlace
                    },
                    attributes: ['id_wb_pagina', 'url_safe', 'fk_id_cat_type_pagina', 'publicada'],
                    raw: true
                });
                
                if (paginaEncontrada) {
                    // Rutas relativas (ej. regeneracion.html, index.html) para SPA bajo subcarpeta
                    href = resolveStaticPageHref(paginaEncontrada, id_sysapp);
                } else {
                    // console.warn(`⚠️ Página ${item.fk_id_wb_pagina} no encontrada para el menú, usando #`);
                href = '#'; // Si no existe la página, usar #
                }
            } catch (error) {
                console.error(`❌ Error resolviendo enlace del menú para página ${item.fk_id_wb_pagina}:`, error);
                href = '#'; // En caso de error, usar #
            }
        }
        
        if (isToggle) {
            if (nivel === 1) {
                // Nivel 1 con submenús: solo toggle, no navegación.
                href = 'javascript:void(0)';
                classes += 'submenu-toggle';
                dataTarget = ` data-target="submenu-${item.id_wb_menu_link}"`;
            } else if (nivel === 2) {
                classes += 'submenu-directorio';
                dataTarget = ` data-target="submenu-children-${item.id_wb_menu_link}"`;
            } else if (nivel === 3) {
                classes += 'submenu-legisladores';
                dataTarget = ` data-target="submenu-children-${item.id_wb_menu_link}"`;
            } else {
                classes += 'submenu-estrados';
                dataTarget = ` data-target="submenu-children-${item.id_wb_menu_link}"`;
            }
        }
        
        return { href, classes, dataTarget };
    }

    async function renderizarSubmenus(items, currentLevel = 2, parentId = null) {
        if (!items || items.length === 0) return '';
        
        const columnId = parentId ? ` id="submenu-children-${parentId}"` : '';
        let html = `<ul class="submenu-column level-${currentLevel}"${columnId}>`;
        
        // Procesar items de forma asíncrona
        for (const item of items) {
            const isToggle = item.submenus && item.submenus.length > 0;
            const attrs = await obtenerAtributosLink(item, isToggle);
            let linkContent = `<a href="${escapeUrl(attrs.href)}" class="${attrs.classes}"${attrs.dataTarget}>`;
            
            if (currentLevel <= 2) {
                linkContent += `<img src="assets/img/arrow-down-solid.svg" class="menuicon">`;
            }
            
            linkContent += `<p class="unopar">${escapeHtml(item.nombre)}</p>`;
            
            if (isToggle) {
                linkContent += `<i class="fa-solid fa-chevron-right chevron"></i>`;
            }
            linkContent += `</a>`;
            
            // Log para debug
            if (attrs.href && attrs.href !== '#') {
                // console.log(`✅ Submenú enlace generado: "${item.nombre}" -> ${attrs.href}`);
            } else {
                // console.warn(`⚠️ Submenú "${item.nombre}" sin href válido`);
            }
            
            html += `<li class="imgMenu">${linkContent}</li>`;
        }
        
        html += `</ul>`;
        
        // Renderizar niveles siguientes
        for (const item of items) {
            if (item.submenus && item.submenus.length > 0) {
                html += await renderizarSubmenus(item.submenus, currentLevel + 1, item.id_wb_menu_link);
            }
        }
        
        return html;
    }

    // Función principal async para procesar el menú
    return (async () => {
        const placeholder = '<li><ul class="submenu-imagen"><li><img src="assets/img/img-menu-responsive.png" alt="Menú Imagen"></li></ul></li>';
        let finalHTML = menuData.length === 0 ? placeholder : '';
        
        // Procesar items del menú de forma asíncrona
        for (const itemNivel1 of menuData) {
            const tieneSubmenus = itemNivel1.submenus && itemNivel1.submenus.length > 0;
            const attrs = await obtenerAtributosLink(itemNivel1, tieneSubmenus);

            // En HTML estático, cualquier item de NIVEL 1 con hijos debe comportarse como toggle.
            // Esto evita fallos cuando link_nivel llega inconsistente desde BD.
            if (tieneSubmenus) {
                attrs.href = 'javascript:void(0)';
                attrs.classes = 'submenu-toggle';
                attrs.dataTarget = ` data-target="submenu-${itemNivel1.id_wb_menu_link}"`;
            }
            
            // Href relativos a .html (mismo directorio que index.html) o URLs absolutas
            let hrefFinal = attrs.href;
            
            // Asegurar que siempre haya un href válido
            if (!hrefFinal || hrefFinal === '#') {
                hrefFinal = 'javascript:void(0)';
            } else if (!hrefFinal.startsWith('http') && !hrefFinal.startsWith('#') && !hrefFinal.startsWith('javascript:')) {
                // No forzar "/" del host: mantener index.html, foo.html o rutas legacy /slug
                if (!hrefFinal.startsWith('/') && !/\.html?$/i.test(hrefFinal) && hrefFinal.indexOf('/') === -1) {
                    hrefFinal = '/' + hrefFinal;
                }
            }

            let linkNivel1 = `<a href="${escapeUrl(hrefFinal)}" class="${attrs.classes}"${attrs.dataTarget}>`;
            linkNivel1 += `<span>${escapeHtml(itemNivel1.nombre)}</span>`;
            if (tieneSubmenus) {
                linkNivel1 += `<i class="fa-solid fa-chevron-down chevron"></i>`;
            }
            linkNivel1 += `</a>`;
            
            finalHTML += `<li>${linkNivel1}`;
            if (tieneSubmenus) {
                finalHTML += `<div class="submenu-container" id="submenu-${itemNivel1.id_wb_menu_link}">`;
                finalHTML += `<div class="submenu-content">`;
                const imgUrl = itemNivel1.url_imagen || 'assets/img/img-menu.png';
                finalHTML += `<ul class="submenu-column level-0"><li><img class="submenuImg" src="${escapeUrl(imgUrl)}" alt="${escapeHtml(itemNivel1.nombre)}"></li></ul>`;
                finalHTML += await renderizarSubmenus(itemNivel1.submenus, 2, itemNivel1.id_wb_menu_link);
                finalHTML += `</div></div>`;
            }
            finalHTML += `</li>`;
        }

        return finalHTML;
    })();
}

/**
 * Renderiza la vista estática
 */
async function renderStaticView(viewData, viewsPath, type_uri) {
    return new Promise((resolve, reject) => {
        // Asegurar que viewsPath apunta al directorio correcto
        // Si viewsPath es relativo, hacerlo absoluto desde process.cwd()
        let absoluteViewsPath = viewsPath;
        if (!path.isAbsolute(viewsPath)) {
            absoluteViewsPath = path.join(process.cwd(), viewsPath);
        }

        // Determinar qué vista usar: tipo 5 = una entrada (detalle), no la lista de entradas
        let viewTemplate;
        const numericType = Number(type_uri);
        if (numericType === 5) {
            viewTemplate = path.join(absoluteViewsPath, 'publics/entradas_detalle.ejs');
        } else {
            viewTemplate = path.join(absoluteViewsPath, 'publics/index_static.ejs');
        }

        // Si no existe index_static, usar index normal
        if (!fs.existsSync(viewTemplate)) {
            viewTemplate = path.join(absoluteViewsPath, 'publics/index.ejs');
        }

        // Verificar que el archivo existe
        if (!fs.existsSync(viewTemplate)) {
            reject(new Error(`No se encontró la vista: ${viewTemplate}`));
            return;
        }

        // Configurar EJS para resolver includes desde el directorio de la vista actual
        // EJS busca includes relativos desde el directorio del archivo actual cuando se establece filename
        const publicsPath = path.join(absoluteViewsPath, 'publics');
        const publicsPartialsPath = path.join(publicsPath, 'partials');
        
        // El orden en views es importante: EJS busca de izquierda a derecha
        // Primero busca en el directorio de la vista actual (gracias a filename)
        // Luego en los directorios especificados en views
        const ejsOptions = {
            views: [publicsPath, publicsPartialsPath, absoluteViewsPath], // Priorizar publics y sus partials
            root: absoluteViewsPath,
            filename: viewTemplate // CRÍTICO: Esto hace que EJS resuelva includes relativos desde el directorio de la vista
        };

        fs.readFile(viewTemplate, 'utf8', (err, template) => {
            if (err) {
                reject(err);
                return;
            }

            try {
                const html = ejs.render(template, viewData, ejsOptions);
                resolve(html);
            } catch (renderErr) {
                reject(renderErr);
            }
        });
    });
}

/**
 * Renderiza una vista estática por ruta de template (entradas, entradas_detalle, regeneracion_detalle).
 */
async function renderStaticViewCustom(viewData, viewsPath, templateRelativePath) {
    return new Promise((resolve, reject) => {
        let absoluteViewsPath = path.isAbsolute(viewsPath) ? viewsPath : path.join(process.cwd(), viewsPath);
        const viewTemplate = path.join(absoluteViewsPath, templateRelativePath);
        if (!fs.existsSync(viewTemplate)) {
            reject(new Error('No se encontró la vista: ' + viewTemplate));
            return;
        }
        const publicsPath = path.join(absoluteViewsPath, 'publics');
        const publicsPartialsPath = path.join(publicsPath, 'partials');
        const ejsOptions = {
            views: [publicsPath, publicsPartialsPath, absoluteViewsPath],
            root: absoluteViewsPath,
            filename: viewTemplate
        };
        fs.readFile(viewTemplate, 'utf8', (err, template) => {
            if (err) return reject(err);
            try {
                resolve(ejs.render(template, viewData, ejsOptions));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Procesa recursos externos e internos, embebiendo o convirtiendo rutas
 */
async function processResources(html, viewsPath) {
    let processedHtml = html;

    // Lista de recursos externos comunes a embebir
    const externalResources = [
        {
            pattern: /https:\/\/ajax\.googleapis\.com\/ajax\/libs\/jquery\/[^"']+/g,
            type: 'script',
            embed: false // Mantener CDN para jQuery
        },
        {
            pattern: /https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/[^"']+/g,
            type: 'link',
            embed: false
        },
        {
            pattern: /https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@[^"']+/g,
            type: 'link',
            embed: false
        },
        {
            pattern: /https:\/\/fonts\.googleapis\.com\/css\?[^"']+/g,
            type: 'link',
            embed: false
        }
    ];

    // EMBEBER TODOS LOS CSS COMO TAGS <style> DENTRO DEL HTML
    const publicPath = path.join(__dirname, '..', 'public');
    const cssFiles = [];
    const processedCSSPaths = new Set();
    
    // console.log('🔍 Buscando TODOS los archivos CSS para embebir en el HTML...');
    // console.log(`📁 Ruta pública: ${publicPath}`);
    
    // MÉTODO 1: Buscar TODOS los tags <link> en el HTML completo
    const allLinks = processedHtml.match(/<link[^>]*>/gi) || [];
    // console.log(`🔗 Total tags <link> encontrados en HTML: ${allLinks.length}`);
    
    allLinks.forEach((linkTag, index) => {
        // Extraer href de diferentes formas posibles
        let hrefValue = null;
        
        // Formato 1: href="..."
        const hrefMatch1 = linkTag.match(/href\s*=\s*["']([^"']+)["']/i);
        if (hrefMatch1) {
            hrefValue = hrefMatch1[1].trim();
        }
        
        // Formato 2: href=... (sin comillas)
        if (!hrefValue) {
            const hrefMatch2 = linkTag.match(/href\s*=\s*([^\s>]+)/i);
            if (hrefMatch2) {
                hrefValue = hrefMatch2[1].trim().replace(/["']/g, '');
            }
        }
        
            if (hrefValue && hrefValue.startsWith('/assets/') && hrefValue.endsWith('.css')) {
                // Mantener la ruta completa: /assets/css/archivo.css -> assets/css/archivo.css
                const assetPath = hrefValue.substring(1); // Quitar el / inicial
                
                // Evitar duplicados
                if (processedCSSPaths.has(assetPath)) {
                    // console.log(`⏭️ CSS ya procesado, saltando: ${assetPath}`);
                    return;
                }
                
                processedCSSPaths.add(assetPath);
                const fullPath = path.join(publicPath, assetPath);
            
            if (fs.existsSync(fullPath)) {
                try {
                    const cssContent = fs.readFileSync(fullPath, 'utf8');
                    // El procesamiento de imágenes se hará después de recopilar todos los CSS
                    // console.log(`✅ CSS #${cssFiles.length + 1} leído: ${assetPath} (${cssContent.length} caracteres)`);
                    cssFiles.push({
                        name: assetPath,
                        content: cssContent
                    });
                } catch (e) {
                    console.error(`❌ Error leyendo CSS ${fullPath}:`, e);
                }
            } else {
                // console.warn(`⚠️ CSS no encontrado en: ${fullPath}`);
            }
        }
    });
    
    // MÉTODO 2: Buscar con replace como respaldo (por si acaso)
    // NOTA: Este método no puede ser async, así que procesaremos el CSS después
    processedHtml = processedHtml.replace(
        /<link[^>]+href\s*=\s*["']\/assets\/([^"']+\.css)["'][^>]*>/gi,
        (match, assetPath) => {
            // Construir ruta completa: assets/css/archivo.css
            const fullAssetPath = `assets/${assetPath}`;
            if (processedCSSPaths.has(fullAssetPath)) {
                return ''; // Ya procesado, remover
            }
            
            const fullPath = path.join(publicPath, 'assets', assetPath);
            if (fs.existsSync(fullPath)) {
                try {
                    const cssContent = fs.readFileSync(fullPath, 'utf8');
                    // El procesamiento de imágenes se hará después de recopilar todos los CSS
                    // console.log(`✅ CSS leído (método 2): ${assetPath}`);
                    cssFiles.push({
                        name: `assets/${assetPath}`,
                        content: cssContent
                    });
                    processedCSSPaths.add(fullAssetPath);
                    return '';
                } catch (e) {
                    console.error(`❌ Error leyendo CSS ${fullPath}:`, e);
                    return match;
                }
            }
            return match;
        }
    );
    
    // MÉTODO 3: Buscar también sin comillas en href
    // NOTA: Este método no puede ser async, así que procesaremos el CSS después
    processedHtml = processedHtml.replace(
        /<link[^>]+href\s*=\s*\/assets\/([^\s>]+\.css)[^>]*>/gi,
        (match, assetPath) => {
            const fullAssetPath = `assets/${assetPath}`;
            if (processedCSSPaths.has(fullAssetPath)) {
                return '';
            }
            
            const fullPath = path.join(publicPath, 'assets', assetPath);
            if (fs.existsSync(fullPath)) {
                try {
                    const cssContent = fs.readFileSync(fullPath, 'utf8');
                    // El procesamiento de imágenes se hará después de recopilar todos los CSS
                    // console.log(`✅ CSS leído (método 3): ${assetPath}`);
                    cssFiles.push({
                        name: `assets/${assetPath}`,
                        content: cssContent
                    });
                    processedCSSPaths.add(fullAssetPath);
                    return '';
                } catch (e) {
                    console.error(`❌ Error leyendo CSS ${fullPath}:`, e);
                    return match;
                }
            }
            return match;
        }
    );
    
    // REMOVER TODOS LOS LINKS DE CSS DEL HTML
    // Remover todos los formatos posibles de links CSS
    processedHtml = processedHtml.replace(
        /<link[^>]*href\s*=\s*["']?\/assets\/[^"'\s>]+\.css["']?[^>]*>/gi,
        ''
    );
    
    // console.log(`📦 Total archivos CSS encontrados y leídos: ${cssFiles.length}`);
    if (cssFiles.length > 0) {
        // console.log(`📋 Archivos CSS: ${cssFiles.map(c => c.name).join(', ')}`);
    }
    
    // Procesar imágenes en TODOS los CSS antes de combinarlos
    // console.log('🎨 Procesando imágenes en CSS...');
    const { processCssImages } = require('./staticPageGenerator');
    
    for (let i = 0; i < cssFiles.length; i++) {
        const cssFile = cssFiles[i];
        const cssFilePath = path.join(publicPath, cssFile.name);
        try {
            cssFile.content = await processCssImages(cssFile.content, cssFilePath);
        } catch (err) {
            // console.warn(`⚠️ Error procesando imágenes en ${cssFile.name}:`, err.message);
        }
        // Reescribir url('../img/...') a url(assets/img/...) para que funcione en HTML estático (file:// o subpath)
        cssFile.content = cssFile.content.replace(/url\(["']?\.\.\/img\//gi, 'url(assets/img/');
    }
    
    // INYECTAR TODOS LOS CSS COMO TAG <style> ANTES DE </head>
    if (cssFiles.length > 0) {
        // Combinar todos los CSS con comentarios para identificar cada uno
        const combinedCSS = cssFiles.map(css => {
            return `/* ========== ${css.name} ========== */\n${css.content}`;
        }).join('\n\n');
        
        // console.log(`💾 Inyectando ${cssFiles.length} archivos CSS (${combinedCSS.length} caracteres totales)`);
        
        // Buscar </head> e inyectar el CSS antes (usar indexOf para ser más preciso)
        const headIndex = processedHtml.indexOf('</head>');
        const HEADIndex = processedHtml.indexOf('</HEAD>');
        
        if (headIndex !== -1) {
            processedHtml = processedHtml.substring(0, headIndex) + 
                `\n<style>\n${combinedCSS}\n</style>\n` + 
                processedHtml.substring(headIndex);
            // console.log(`✅ CSS inyectado correctamente ANTES de </head> en posición ${headIndex}`);
        } else if (HEADIndex !== -1) {
            processedHtml = processedHtml.substring(0, HEADIndex) + 
                `\n<style>\n${combinedCSS}\n</style>\n` + 
                processedHtml.substring(HEADIndex);
            // console.log(`✅ CSS inyectado correctamente ANTES de </HEAD> en posición ${HEADIndex}`);
        } else {
            // Si no hay </head>, buscar <body> o agregar antes de </html>
            const bodyIndex = processedHtml.indexOf('<body');
            if (bodyIndex !== -1) {
                const bodyEndIndex = processedHtml.indexOf('>', bodyIndex);
                if (bodyEndIndex !== -1) {
                    processedHtml = processedHtml.substring(0, bodyEndIndex + 1) + 
                        `\n<style>\n${combinedCSS}\n</style>` + 
                        processedHtml.substring(bodyEndIndex + 1);
                    // console.log('✅ CSS inyectado después de <body>');
                }
            } else {
                // Último recurso: agregar después de <html>
                const htmlIndex = processedHtml.indexOf('<html');
                if (htmlIndex !== -1) {
                    const htmlEndIndex = processedHtml.indexOf('>', htmlIndex);
                    if (htmlEndIndex !== -1) {
                        processedHtml = processedHtml.substring(0, htmlEndIndex + 1) + 
                            `\n<style>\n${combinedCSS}\n</style>` + 
                            processedHtml.substring(htmlEndIndex + 1);
                        // console.log('✅ CSS inyectado después de <html>');
                    }
                } else {
                    // Si no hay nada, agregar al inicio
                    processedHtml = `<style>\n${combinedCSS}\n</style>\n` + processedHtml;
                    // console.log('✅ CSS inyectado al inicio del HTML');
                }
            }
        }
        
        // console.log(`🎉 CSS embebido exitosamente! Total: ${cssFiles.length} archivos, ${combinedCSS.length} caracteres`);
    } else {
        console.error('❌ NO SE ENCONTRARON ARCHIVOS CSS PARA EMBEBIR - VERIFICAR RUTAS');
    }

    // Convertir TODAS las imágenes a base64 (incluyendo logos, imágenes del menú, etc.)
    // console.log('🖼️ Procesando TODAS las imágenes para convertir a base64...');
    const processedImages = new Set();
    
    // Procesar imágenes con src="/assets/..."
    processedHtml = processedHtml.replace(
        /src=["']\/assets\/([^"']+\.(png|jpg|jpeg|gif|svg|webp))["']/gi,
        (match, imgPath) => {
            if (processedImages.has(imgPath)) {
                return match; // Ya procesada
            }
            
            const fullPath = path.join(publicPath, 'assets', imgPath);
            if (fs.existsSync(fullPath)) {
                try {
                    const imgBuffer = fs.readFileSync(fullPath);
                    const ext = path.extname(imgPath).toLowerCase().substring(1);
                    const mimeType = {
                        'png': 'image/png',
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'gif': 'image/gif',
                        'svg': 'image/svg+xml',
                        'webp': 'image/webp'
                    }[ext] || 'image/png';
                    
                    const base64 = imgBuffer.toString('base64');
                    processedImages.add(imgPath);
                    // console.log(`✅ Imagen convertida a base64: ${imgPath} (${(imgBuffer.length / 1024).toFixed(2)} KB)`);
                    return `src="data:${mimeType};base64,${base64}"`;
                } catch (e) {
                    console.error(`❌ Error procesando imagen ${imgPath}:`, e);
                    return match;
                }
            } else {
                // console.warn(`⚠️ Imagen no encontrada: ${fullPath}`);
            }
            return match;
        }
    );
    
    // Procesar imágenes con src="../assets/..." (rutas relativas)
    processedHtml = processedHtml.replace(
        /src=["']\.\.\/assets\/([^"']+\.(png|jpg|jpeg|gif|svg|webp))["']/gi,
        (match, imgPath) => {
            if (processedImages.has(imgPath)) {
                return match; // Ya procesada
            }
            
            const fullPath = path.join(publicPath, 'assets', imgPath);
            if (fs.existsSync(fullPath)) {
                try {
                    const imgBuffer = fs.readFileSync(fullPath);
                    const ext = path.extname(imgPath).toLowerCase().substring(1);
                    const mimeType = {
                        'png': 'image/png',
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'gif': 'image/gif',
                        'svg': 'image/svg+xml',
                        'webp': 'image/webp'
                    }[ext] || 'image/png';
                    
                    const base64 = imgBuffer.toString('base64');
                    processedImages.add(imgPath);
                    // console.log(`✅ Imagen convertida a base64 (relativa): ${imgPath} (${(imgBuffer.length / 1024).toFixed(2)} KB)`);
                    return `src="data:${mimeType};base64,${base64}"`;
                } catch (e) {
                    console.error(`❌ Error procesando imagen relativa ${imgPath}:`, e);
                    return match;
                }
            } else {
                // console.warn(`⚠️ Imagen relativa no encontrada: ${fullPath}`);
            }
            return match;
        }
    );
    
    // console.log(`🎉 Total imágenes procesadas: ${processedImages.size}`);

    // Remover scripts que hacen llamadas AJAX a /public/getComponente
    // Estos componentes ya están pre-renderizados en el HTML
    processedHtml = processedHtml.replace(
        /<script>[\s\S]*?fetch\(['"]\/public\/getComponente['"][\s\S]*?<\/script>/gi,
        ''
    );

    // Remover scripts jQuery que procesan componentes dinámicamente
    processedHtml = processedHtml.replace(
        /\$\(function\s*\(\)\s*\{[\s\S]*?componentesParaRenderizar[\s\S]*?\}\);/gi,
        ''
    );
    
    // Remover el script que hace fetch a /menu-data (el menú ya está pre-renderizado)
    processedHtml = processedHtml.replace(
        /<script>[\s\S]*?fetch\(['"]\/menu-data['"][\s\S]*?<\/script>/gi,
        ''
    );
    
    // Remover la función obtenerMenu() completa si existe
    processedHtml = processedHtml.replace(
        /async\s+function\s+obtenerMenu\(\)\s*\{[\s\S]*?\}/gi,
        ''
    );
    
    // Remover llamadas a obtenerMenu() en document.ready
    processedHtml = processedHtml.replace(
        /obtenerMenu\(\)\s*;/gi,
        '// Menú ya está pre-renderizado'
    );
    
    // Remover el script que hace fetch a /footer-data (el footer ya está pre-renderizado)
    processedHtml = processedHtml.replace(
        /<script>[\s\S]*?fetch\(['"]\/footer-data['"][\s\S]*?<\/script>/gi,
        ''
    );
    
    // Remover la función obtenerFooter() completa si existe
    processedHtml = processedHtml.replace(
        /async\s+function\s+obtenerFooter\(\)\s*\{[\s\S]*?\}/gi,
        ''
    );
    
    // Remover llamadas a obtenerFooter() en document.ready o $(document).ready
    processedHtml = processedHtml.replace(
        /obtenerFooter\(\)\s*;/gi,
        '// Footer ya está pre-renderizado'
    );
    
    // Remover funciones renderizarFooter y renderizarFooterVacio si existen
    processedHtml = processedHtml.replace(
        /function\s+renderizarFooter\([\s\S]*?\n\s*\}\s*\n/gi,
        '// Footer renderizado estáticamente\n'
    );
    processedHtml = processedHtml.replace(
        /function\s+renderizarFooterVacio\([\s\S]*?\n\s*\}\s*\n/gi,
        '// Footer renderizado estáticamente\n'
    );
    
    // Modificar TODOS los enlaces dentro del HTML para que funcionen con el router del padre
    // Usar window.top.location.hash que funciona incluso con restricciones de seguridad
    // console.log('🔗 Modificando enlaces para router...');
    let enlacesModificados = 0;
    
    function shouldPatchLink(href) {
        if (!href) return false;
        const v = String(href).trim();
        if (!v || v === '#' || v === '/#') return false;
        if (
            v.startsWith('javascript:') ||
            v.startsWith('mailto:') ||
            v.startsWith('tel:') ||
            v.startsWith('http://') ||
            v.startsWith('https://') ||
            v.startsWith('//')
        ) return false;
        if (v.startsWith('/assets/') || v.startsWith('assets/') || v.startsWith('/api/') || v.startsWith('api/')) return false;
        return true;
    }

    function toInternalRoute(href) {
        if (!href || href === '/') return '';
        let route = String(href).trim();
        const hashIndex = route.indexOf('#');
        if (hashIndex >= 0) route = route.substring(0, hashIndex);
        const queryIndex = route.indexOf('?');
        if (queryIndex >= 0) route = route.substring(0, queryIndex);
        if (route.endsWith('/index.html')) route = route.slice(0, -'/index.html'.length);
        else if (route.endsWith('.html')) route = route.slice(0, -5);
        else if (route.endsWith('.htm')) route = route.slice(0, -4);
        route = route.replace(/^\.?\//, '').replace(/^\/+/, '');
        if (!route) return '';
        return '/' + route;
    }

    function addRouterOnclick(match, before, href, after) {
        if (!shouldPatchLink(href)) return match;
        const normalizedHref = toInternalRoute(href);
        const onclickCode = `(function(e){
                e = e || window.event;
                try{
                    if(e.preventDefault) e.preventDefault();
                    if(e.stopPropagation) e.stopPropagation();
                    // console.log('🔗 Navegando desde iframe a:', '${normalizedHref}');
                    // Usar postMessage para comunicarse con el padre
                    if(window.parent && window.parent !== window){
                        window.parent.postMessage({type:'navigate', route:'${normalizedHref}'}, '*');
                    } else if(window.top && window.top !== window){
                        window.top.postMessage({type:'navigate', route:'${normalizedHref}'}, '*');
                    }
                    return false;
                }catch(err){
                    console.error('Error navegando:', err);
                }
            })(event)`;
        const hasOnclick = /onclick\s*=/i.test(before + after);
        if (hasOnclick) {
            const onclickMatch = match.match(/onclick\s*=\s*["']([^"']*)["']/i);
            if (onclickMatch) {
                const existingOnclick = onclickMatch[1];
                const newOnclick = `${onclickCode}; ${existingOnclick}`;
                return match.replace(/onclick\s*=\s*["'][^"']*["']/i, `onclick="${newOnclick}"`);
            }
        }
        enlacesModificados++;
        return `<a${before} href="${href}" onclick="${onclickCode}"${after}>`;
    }

    // Enlaces absolutos internos (/ruta)
    processedHtml = processedHtml.replace(
        /<a([^>]*)\s+href=["'](\/[^"']+)["']([^>]*)>/gi,
        (match, before, href, after) => addRouterOnclick(match, before, href, after)
    );

    // Enlaces relativos internos (ruta, ruta.html, ./ruta, etc.)
    processedHtml = processedHtml.replace(
        /<a([^>]*)\s+href=["']((?![#\/]|[a-z]+:|\/\/)[^"']+)["']([^>]*)>/gi,
        (match, before, href, after) => addRouterOnclick(match, before, href, after)
    );
    
    // console.log(`🎉 Total enlaces modificados: ${enlacesModificados}`);

    return processedHtml;
}

/**
 * Embebe en el HTML el CSS de /assets/*.css que se referencia con <link>,
 * sin tocar el resto del contenido ni los scripts.
 */
async function embedAssetsCssForHtml(html) {
    try {
        const publicPath = path.join(__dirname, '..', 'public');
        const cssFiles = [];
        const processedPaths = new Set();

        // Buscar links a /assets/*.css
        const linkRegex = /<link[^>]*href\s*=\s*["']\/assets\/([^"']+\.css)["'][^>]*>/gi;
        let match;
        while ((match = linkRegex.exec(html)) !== null) {
            const assetRelPath = match[1]; // ej. css/estilos_general.css
            const assetPathForSet = `assets/${assetRelPath}`;
            if (processedPaths.has(assetPathForSet)) continue;
            const fullPath = path.join(publicPath, 'assets', assetRelPath);
            if (fs.existsSync(fullPath)) {
                try {
                    const cssContent = fs.readFileSync(fullPath, 'utf8');
                    cssFiles.push({
                        name: assetPathForSet,
                        content: cssContent
                    });
                    processedPaths.add(assetPathForSet);
                } catch (e) {
                    console.error(`Error leyendo CSS para embebido (${fullPath}):`, e);
                }
            }
        }

        if (cssFiles.length === 0) {
            return html;
        }

        const combinedCSS = cssFiles.map(css => {
            return `/* ========== ${css.name} ========== */\n${css.content}`;
        }).join('\n\n');

        const styleTag = `\n<style>\n${combinedCSS}\n</style>\n`;

        const headIndex = html.indexOf('</head>');
        if (headIndex !== -1) {
            return html.slice(0, headIndex) + styleTag + html.slice(headIndex);
        }

        // Si no hay </head>, insertar al inicio
        return styleTag + html;
    } catch (e) {
        console.error('Error embebiendo CSS de assets en HTML:', e);
        return html;
    }
}

/**
 * Ofusca JavaScript inline en el HTML
 */
async function obfuscateInlineJS(html) {
    // No transformar JS inline: el stripping de comentarios rompe URLs (https://)
    // y termina invalidando scripts de componentes como colección fotográfica.
    return html;
}

/**
 * Nombre de archivo estable por página. Siempre el mismo para sobrescribir.
 * Usamos .html para que el navegador los reconozca cuando se abren directamente (file://).
 * Las URLs visibles NO muestran .html porque Express maneja las rutas.
 */
function getStablePageFileName(pagina_uri) {
    return slugifyPaginaUri(pagina_uri) + '.html';
}

/**
 * Nombre de archivo para páginas virtuales (entradas, regeneración).
 * entradas -> entradas.html; regeneracion -> regeneracion.html; entradas/slug -> entradas/slug.html
 */
function getStableFileNameForVirtual(pagina_uri) {
    if (!pagina_uri || typeof pagina_uri !== 'string') return 'pagina.html';
    const u = pagina_uri.replace(/^\/+|\/+$/g, '');
    if (u === 'entradas') return 'entradas.html';
    if (u === 'regeneracion') return 'regeneracion.html';
    if (u.startsWith('entradas/')) {
        const slug = u.replace(/^entradas\/+/, '').replace(/\/+/g, '-');
        return 'entradas/' + (slugifyPaginaUri(slug) || 'entrada') + '.html';
    }
    return slugifyPaginaUri(u) + '.html';
}

/**
 * Prefijo hacia la carpeta assets/ del dist según la ruta del HTML generado.
 * Ej.: `home.html` -> `assets/`; `entradas/foo.html` -> `../assets/` (evita rutas rotas al abrir el archivo).
 */
function getAssetPrefixForStaticOutput(outputFileName) {
    if (!outputFileName || typeof outputFileName !== 'string') return 'assets/';
    const normalized = outputFileName.replace(/\\/g, '/');
    const dir = path.posix.dirname(normalized);
    if (!dir || dir === '.') return 'assets/';
    const depth = dir.split('/').filter(Boolean).length;
    return depth > 0 ? '../'.repeat(depth) + 'assets/' : 'assets/';
}

function normalizeStaticFileHtmlPaths(html, outputFileName) {
    if (!html || typeof html !== 'string') return html;
    const ap = getAssetPrefixForStaticOutput(outputFileName);
    const normalized = typeof outputFileName === 'string' ? outputFileName.replace(/\\/g, '/') : '';
    const dirname = normalized ? path.posix.dirname(normalized) : '';
    const depth = dirname && dirname !== '.' ? dirname.split('/').filter(Boolean).length : 0;

    let out = html
        // Atributos con comillas: src="/assets/... href="/assets/...
        .replace(/(src|href)\s*=\s*(["'])\/assets\//gi, `$1=$2${ap}`)
        .replace(/(src|href)\s*=\s*(["'])https?:\/\/cdn\.morena\.app\/assets\//gi, `$1=$2${ap}`)
        // Atributos sin comillas (minified): src=/assets/... href=/assets/...
        .replace(/(src|href)\s*=\s*\/assets\//gi, `$1=${ap}`)
        // Cualquier /assets/ restante en comillas
        .replace(/(["'])\/assets\//g, `$1${ap}`)
        .replace(/(["'])https?:\/\/cdn\.morena\.app\/assets\//g, `$1${ap}`)
        // CSS url() y @import
        .replace(/url\((["']?)\/assets\//gi, `url($1${ap}`)
        .replace(/url\((["']?)https?:\/\/cdn\.morena\.app\/assets\//gi, `url($1${ap}`)
        .replace(/@import\s+(["'])\/assets\//gi, `@import $1${ap}`)
        // url('../img/...') en CSS embebido
        .replace(/url\(["']?\.\.\/img\//gi, `url(${ap}img/`);

    // Rutas ya relativas tipo assets/... (header con assetsPrefix) — solo hace falta subir de nivel en subcarpetas
    if (depth > 0) {
        out = out
            .replace(/(src|href)\s*=\s*(["'])assets\//gi, `$1=$2${ap}`)
            .replace(/(src|href)\s*=\s*assets\//gi, `$1=${ap}`)
            .replace(/url\((["']?)assets\//gi, `url($1${ap}`)
            .replace(/@import\s+(["'])assets\//gi, `@import $1${ap}`);
    }
    return out;
}

function ensureStaticAssetsInDist(appDir) {
    try {
        const sourceAssetsDir = path.join(__dirname, '..', 'public', 'assets');
        const targetAssetsDir = path.join(appDir, 'assets');
        if (!fs.existsSync(sourceAssetsDir)) return;
        fs.cpSync(sourceAssetsDir, targetAssetsDir, { recursive: true });
        console.log('[staticGenerator] assets copiados a dist:', targetAssetsDir);
    } catch (e) {
        console.warn('[staticGenerator] No se pudieron copiar assets al dist:', e.message);
    }
}

/**
 * Guarda el HTML estático. Siempre sobrescribe el mismo archivo (no copias).
 */
async function saveStaticHTML(htmlContent, objapp, objpagina, pagina_uri) {
    const distDir = getDistDirBase(objapp.id_sysapp, objapp);
    console.log('[staticGenerator] saveStaticHTML inicio:', { id_sysapp: objapp.id_sysapp, id_wb_pagina: objpagina.id_wb_pagina, pagina_uri, distDir });

    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
        console.log('[staticGenerator] saveStaticHTML creado distDir:', distDir);
    }

    const appDir = path.join(distDir, `app_${objapp.id_sysapp}`);
    if (!fs.existsSync(appDir)) {
        fs.mkdirSync(appDir, { recursive: true });
        console.log('[staticGenerator] saveStaticHTML creado appDir:', appDir);
    }
    ensureStaticAssetsInDist(appDir);

    const fileName = getStablePageFileName(pagina_uri);
    const filePath = path.join(appDir, fileName);

    const mappingFile = path.join(appDir, 'mapping.json');
    let mapping = {};
    
    if (fs.existsSync(mappingFile)) {
        try {
            mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        } catch (e) {
            console.error('Error leyendo mapping:', e);
        }
    }

    const pageKey = `${objpagina.id_wb_pagina}_${pagina_uri}`;
    const oldEntry = mapping[pageKey];
    if (oldEntry && oldEntry.fileName && oldEntry.fileName !== fileName) {
        const oldPath = oldEntry.filePath || path.join(appDir, oldEntry.fileName);
        if (fs.existsSync(oldPath)) {
            try {
                fs.unlinkSync(oldPath);
            } catch (e) {
                // console.warn('No se pudo eliminar archivo anterior:', oldPath, e.message);
            }
        }
    }

    const normalizedHtml = normalizeStaticFileHtmlPaths(htmlContent, fileName);
    fs.writeFileSync(filePath, normalizedHtml, 'utf8');
    console.log('[staticGenerator] saveStaticHTML escrito archivo:', filePath, '(bytes:', Buffer.byteLength(normalizedHtml, 'utf8') + ')');

    mapping[pageKey] = {
        fileName: fileName,
        filePath: filePath,
        generatedAt: new Date().toISOString(),
        id_wb_pagina: objpagina.id_wb_pagina,
        pagina_uri: pagina_uri,
        id_sysapp: objapp.id_sysapp
    };

    // Si esta página es la raíz (home, pagina_uri === '/'),
    // limpiar entradas antiguas de home para que solo exista una en mapping.
    if (pagina_uri === '/') {
        for (const [key, value] of Object.entries(mapping)) {
            if (key !== pageKey && value && value.pagina_uri === '/') {
                delete mapping[key];
            }
        }
    }

    fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');
    console.log('[staticGenerator] saveStaticHTML actualizado mapping.json');

    // Compatibilidad producción: algunos hosts leen /data/app_{id} y otros dist_{slug}/app_{id}.
    // Siempre reflejamos también en DATA_OUTPUT_PATH para evitar "actualicé HTML pero no se ve".
    writeToDataIfEnabled(objapp.id_sysapp, fileName, normalizedHtml);
    writeToDataIfEnabled(objapp.id_sysapp, 'mapping.json', JSON.stringify(mapping, null, 2));

    await generateMainIndex(objapp.id_sysapp, objapp);
    console.log('[staticGenerator] saveStaticHTML listo, filePath:', filePath);

    return filePath;
}

/**
 * Guarda HTML estático de una página virtual (entradas, regeneración, detalle entrada).
 * virtualKey: ej. 'entradas_list', 'regeneracion', 'entrada_123'
 * pagina_uri: ej. 'entradas', 'regeneracion', 'entradas/mi-slug'
 * fileName: ej. 'entradas.html', 'regeneracion.html', 'entradas/mi-slug.html'
 */
async function saveStaticHTMLVirtual(htmlContent, objapp, virtualKey, pagina_uri, fileName) {
    const distDir = getDistDirBase(objapp.id_sysapp, objapp);
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

    const appDir = path.join(distDir, `app_${objapp.id_sysapp}`);
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
    ensureStaticAssetsInDist(appDir);

    const filePath = path.join(appDir, fileName);
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

    const mappingFile = path.join(appDir, 'mapping.json');
    let mapping = {};
    if (fs.existsSync(mappingFile)) {
        try {
            mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        } catch (e) {
            console.error('Error leyendo mapping:', e);
        }
    }

    const pageKey = virtualKey;
    const oldEntry = mapping[pageKey];
    if (oldEntry && oldEntry.fileName && oldEntry.fileName !== fileName) {
        const oldPath = path.join(appDir, oldEntry.fileName);
        if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch (e) { /* ignore */ }
        }
    }

    const normalizedHtml = normalizeStaticFileHtmlPaths(htmlContent, fileName);
    fs.writeFileSync(filePath, normalizedHtml, 'utf8');
    mapping[pageKey] = {
        fileName: fileName,
        filePath: filePath,
        generatedAt: new Date().toISOString(),
        id_wb_pagina: null,
        pagina_uri: pagina_uri,
        id_sysapp: objapp.id_sysapp,
        virtual: true
    };
    fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');

    // Compatibilidad producción: mantener sincronizado DATA_OUTPUT_PATH en todas las regeneraciones.
    writeToDataIfEnabled(objapp.id_sysapp, fileName, normalizedHtml);
    writeToDataIfEnabled(objapp.id_sysapp, 'mapping.json', JSON.stringify(mapping, null, 2));

    await generateMainIndex(objapp.id_sysapp, objapp);
    return filePath;
}

/**
 * Elimina el HTML estático de una página virtual por virtualKey o pagina_uri.
 */
async function deleteStaticHTMLVirtual(objapp, virtualKeyOrPaginaUri) {
    try {
        const distDir = getDistDirBase(objapp.id_sysapp, objapp);
        const appDir = path.join(distDir, `app_${objapp.id_sysapp}`);
        const mappingFile = path.join(appDir, 'mapping.json');
        if (!fs.existsSync(mappingFile)) return false;

        const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        let pageKey = virtualKeyOrPaginaUri;
        let entry = mapping[pageKey];
        if (!entry) {
            for (const [key, value] of Object.entries(mapping)) {
                if (value.virtual && (value.pagina_uri === virtualKeyOrPaginaUri || key === virtualKeyOrPaginaUri)) {
                    entry = value;
                    pageKey = key;
                    break;
                }
            }
        }
        if (!entry) return false;

        const filePath = entry.filePath || path.join(appDir, entry.fileName);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { console.error('Error eliminando archivo virtual:', e.message); }
        }
        delete mapping[pageKey];
        fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');

        deleteFromDataIfEnabled(objapp.id_sysapp, entry.fileName);
        writeToDataIfEnabled(objapp.id_sysapp, 'mapping.json', JSON.stringify(mapping, null, 2));

        await generateMainIndex(objapp.id_sysapp, objapp);
        return true;
    } catch (error) {
        console.error('Error eliminando HTML estático virtual:', error);
        return false;
    }
}

/**
 * Elimina el HTML estático de una página
 */
async function deleteStaticHTML(objapp, objpagina, pagina_uri) {
    try {
        const distDir = getDistDirBase(objapp.id_sysapp, objapp);
        const appDir = path.join(distDir, `app_${objapp.id_sysapp}`);
        const mappingFile = path.join(appDir, 'mapping.json');

        if (!fs.existsSync(mappingFile)) {
            // console.warn(`⚠️ No existe mapping.json para app ${objapp.id_sysapp}`);
            return false;
        }

        const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        
        // Normalizar pagina_uri (asegurar que empiece con /)
        const normalizedUri = pagina_uri && !pagina_uri.startsWith('/') ? `/${pagina_uri}` : (pagina_uri || '/');
        
        // Intentar encontrar por pageKey exacto
        let pageKey = `${objpagina.id_wb_pagina}_${normalizedUri}`;
        let entry = mapping[pageKey];
        
        // Si no se encuentra, buscar por id_wb_pagina en todas las entradas
        if (!entry) {
            for (const [key, value] of Object.entries(mapping)) {
                if (value.id_wb_pagina === objpagina.id_wb_pagina) {
                    entry = value;
                    pageKey = key;
                    break;
                }
            }
        }

        if (entry) {
            const filePath = entry.filePath || path.join(appDir, entry.fileName);
            
            // Eliminar archivo HTML
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (unlinkError) {
                    console.error(`⚠️ Error eliminando archivo ${filePath}:`, unlinkError.message);
                }
            }

            deleteFromDataIfEnabled(objapp.id_sysapp, entry.fileName);

            // Eliminar entrada del mapping
            delete mapping[pageKey];
            fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');
            writeToDataIfEnabled(objapp.id_sysapp, 'mapping.json', JSON.stringify(mapping, null, 2));

            // Regenerar index.html
            await generateMainIndex(objapp.id_sysapp, objapp);

            return true;
        } else {
            // console.warn(`⚠️ No se encontró entrada en mapping para página ${objpagina.id_wb_pagina} con URI ${normalizedUri}`);
            return false;
        }
    } catch (error) {
        console.error('Error eliminando HTML estático:', error);
        return false;
    }
}

/**
 * Genera el index.html principal que actúa como router para todas las páginas estáticas
 */
async function generateMainIndex(id_sysapp, objapp = null) {
    try {
        const distDir = getDistDirBase(id_sysapp, objapp);
        const appDir = path.join(distDir, `app_${id_sysapp}`);
        const mappingFile = path.join(appDir, 'mapping.json');
        const indexFile = path.join(appDir, 'index.html');

        if (!fs.existsSync(mappingFile)) {
            // console.warn(`⚠️ No existe mapping.json para app ${id_sysapp}, no se puede generar index.html`);
            return;
        }

        const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));

        // Buscar la página home (pagina_uri === '/')
        let homePage = null;
        for (const [key, value] of Object.entries(mapping)) {
            if (value.pagina_uri === '/' || value.pagina_uri === '') {
                homePage = value;
                break;
            }
        }

        // Si no hay home, usar la primera página disponible
        if (!homePage && Object.keys(mapping).length > 0) {
            homePage = Object.values(mapping)[0];
        }

        const appTitle = (objapp && (objapp.app_legend || objapp.sysapp_name)) ? (objapp.app_legend || objapp.sysapp_name) : 'Morena';
        const appFavicon = (objapp && objapp.app_favicon) ? objapp.app_favicon : '';
        const appDesc = (objapp && objapp.app_desc) ? objapp.app_desc : '';

        // Generar el HTML del index con router JavaScript
        const indexHTML = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${appTitle}</title>
    ${appFavicon ? `<link rel="icon" type="image/x-icon" href="${appFavicon}">` : ''}
    ${appDesc ? `<meta name="description" content="${appDesc}">` : ''}
    <style>
        #loading {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: #fff;
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 9999;
        }
        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #3498db;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
    <!-- jQuery + iconos: el menú inyectado en #app-container los necesita (scripts de cada página) -->
    <script src="https://code.jquery.com/jquery-3.6.4.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
</head>
<body>
    <div id="loading">
        <div class="spinner"></div>
    </div>
    <div id="app-container"></div>

    <script>
        // Verificar que los elementos existan
        // console.log('🔧 Verificando elementos del DOM...');
        // console.log('Loading element:', document.getElementById('loading') ? '✅' : '❌');
        // console.log('App container:', document.getElementById('app-container') ? '✅' : '❌');
        // Detectar si estamos en archivo local
        const isFileProtocol = window.location.protocol === 'file:' || window.location.protocol === '';
        
        /**
         * Prefijo de despliegue (ej. /paginas/dist_morena-nacional/app_94/) para que pushState no use / del host.
         * En file:// no aplica (se usa hash).
         */
        function getDeploymentBase() {
            if (isFileProtocol) return '';
            const p = window.location.pathname || '/';
            if (p.endsWith('/')) return p;
            if (/\\/index\\.html?$/i.test(p)) return p.replace(/\\/index\\.html?$/i, '/');
            if (/\.html?$/i.test(p)) return p.substring(0, p.lastIndexOf('/') + 1);
            if (/\\/app_\\d+$/i.test(p)) return p + '/';
            const lastSlash = p.lastIndexOf('/');
            return lastSlash > 0 ? p.substring(0, lastSlash + 1) : '/';
        }
        const DEPLOY_BASE = getDeploymentBase();
        function urlForPushState(internalRoute) {
            if (isFileProtocol) return '';
            let base = DEPLOY_BASE || '/';
            if (!base.endsWith('/')) base += '/';
            if (internalRoute === '/' || internalRoute === '') return base;
            const seg = String(internalRoute).replace(/^\\//, '');
            return base + seg;
        }
        function pathnameToInternalRoute(pathname) {
            if (!pathname || pathname === '/') return '/';
            let base = DEPLOY_BASE || '/';
            if (!base.endsWith('/')) base += '/';
            let baseNoSlash = base;
            while (baseNoSlash.length > 1 && baseNoSlash.endsWith('/')) baseNoSlash = baseNoSlash.slice(0, -1);
            if (baseNoSlash && (pathname === baseNoSlash || pathname === baseNoSlash + '/' || pathname === baseNoSlash + '/index.html')) return '/';
            if (pathname.startsWith(base)) {
                let rest = pathname.slice(base.length).replace(/^\\//, '');
                if (rest.endsWith('index.html')) rest = rest.slice(0, -'index.html'.length);
                else if (rest.endsWith('.html')) rest = rest.slice(0, -5);
                else if (rest.endsWith('.htm')) rest = rest.slice(0, -4);
                while (rest.length > 1 && rest.endsWith('/')) rest = rest.slice(0, -1);
                if (!rest) return '/';
                return '/' + rest.replace(/^\\//, '');
            }
            if (pathname === '/index.html' || pathname === '/index.htm' || pathname.endsWith('/index.html')) return '/';
            if (DEPLOY_BASE === '/' && pathname.charAt(0) === '/' && pathname.length > 1) return pathname;
            return pathname;
        }
        /** Resuelve href del mismo origen a ruta interna (/foo) para el mapping; null si no aplica al router. */
        function hrefToInternalRoute(hrefAttr) {
            if (!hrefAttr || hrefAttr === '#' || hrefAttr.startsWith('javascript:') || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:')) return null;
            try {
                var abs = (hrefAttr.indexOf('http://') === 0 || hrefAttr.indexOf('https://') === 0 || hrefAttr.indexOf('file://') === 0)
                    ? new URL(hrefAttr)
                    : new URL(hrefAttr, window.location.href);
                if (abs.origin !== window.location.origin) return null;
                var p = abs.pathname || '/';
                // assets/api en cualquier segmento (también bajo /prefijo/app_N/assets/…)
                if (p.indexOf('/assets/') !== -1 || p.indexOf('/api/') !== -1) return null;
                if (p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length);
                else if (p.endsWith('.html')) p = p.slice(0, -5);
                else if (p.endsWith('.htm')) p = p.slice(0, -4);
                return pathnameToInternalRoute(p);
            } catch (err) {
                return null;
            }
        }

        function rewriteAssetUrl(url) {
            if (!url) return url;
            var trimmed = String(url).trim();
            if (
                trimmed === '' ||
                trimmed.startsWith('#') ||
                trimmed.startsWith('data:') ||
                trimmed.startsWith('javascript:') ||
                trimmed.startsWith('mailto:') ||
                trimmed.startsWith('tel:') ||
                trimmed.startsWith('//')
            ) return trimmed;
            if (trimmed.startsWith('/api/')) return trimmed;
            if (trimmed.startsWith('https://cdn.morena.app/assets/')) {
                return 'assets/' + trimmed.substring('https://cdn.morena.app/assets/'.length);
            }
            if (trimmed.startsWith('http://cdn.morena.app/assets/')) {
                return 'assets/' + trimmed.substring('http://cdn.morena.app/assets/'.length);
            }
            if (trimmed.startsWith('/assets/')) {
                return trimmed.substring(1);
            }
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
            if (trimmed.startsWith('/')) {
                var base = DEPLOY_BASE || '/';
                if (base.endsWith('/')) base = base.slice(0, -1);
                return base + trimmed;
            }
            return trimmed;
        }

        function injectIframeFixes(iframeDoc, iframeWin) {
            var styleId = 'spa-subpath-hotfix-style';
            if (!iframeDoc.getElementById(styleId)) {
                var style = iframeDoc.createElement('style');
                style.id = styleId;
                style.textContent = '.carousel-item{transition:transform .75s ease-in-out !important}.submenu-container{overflow-x:visible !important}@media (max-width: 951px){.submenu-mobile-hidden{display:none !important}.submenu-container{max-width:calc(100vw - 10px) !important}.submenu-content{overflow-x:hidden !important}}';
                iframeDoc.head.appendChild(style);
            }

            if (!iframeWin.__spaCarouselPatched) {
                iframeDoc.addEventListener('click', function(e) {
                    var control = e.target.closest('.carousel-control-prev, .carousel-control-next, [data-bs-slide]');
                    if (!control) return;
                    var targetSelector = control.getAttribute('data-bs-target');
                    var carouselEl = control.closest('.carousel') || (targetSelector ? iframeDoc.querySelector(targetSelector) : null);
                    if (!carouselEl) return;
                    var bs = iframeWin.bootstrap;
                    if (!bs || !bs.Carousel) return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    var instance = bs.Carousel.getOrCreateInstance(carouselEl, { interval: false, ride: false, wrap: true });
                    if (control.matches('.carousel-control-prev, [data-bs-slide="prev"]')) instance.prev();
                    else instance.next();
                }, true);
                iframeWin.__spaCarouselPatched = true;
            }

            if (!iframeWin.__spaMenuPatched) {
                iframeDoc.addEventListener('click', function(e) {
                    var mainToggle = e.target.closest('.submenu-toggle');
                    if (mainToggle) {
                        iframeDoc.querySelectorAll('.submenu-mobile-hidden').forEach(function(el){ el.classList.remove('submenu-mobile-hidden'); });
                    }
                    var trigger = e.target.closest('.submenu-directorio, .submenu-legisladores, .submenu-estrados');
                    if (!trigger) return;
                    if ((iframeWin.innerWidth || 0) > 951) return;
                    var column = trigger.closest('.submenu-column');
                    if (!column) return;
                    var currentLi = trigger.closest('li');
                    var siblings = column.querySelectorAll(':scope > li');
                    siblings.forEach(function(li) {
                        if (currentLi && li !== currentLi) li.classList.add('submenu-mobile-hidden');
                    });
                }, true);
                var scrollCloseTimer;
                iframeWin.addEventListener('scroll', function() {
                    // Solo en vista estrecha: cerrar mega-menú al hacer scroll (UX móvil).
                    // En desktop el scroll del contenido no debe cerrar el menú de forma intermitente.
                    if ((iframeWin.innerWidth || 0) > 951) return;
                    if (!iframeDoc.querySelector('.submenu-container.active')) return;
                    if (scrollCloseTimer) clearTimeout(scrollCloseTimer);
                    scrollCloseTimer = setTimeout(function() {
                        scrollCloseTimer = null;
                        iframeDoc.querySelectorAll('.submenu-container.active').forEach(function(c) {
                            c.classList.remove('active', 'align-right');
                            c.style.maxWidth = '';
                            c.style.display = 'none';
                        });
                        iframeDoc.querySelectorAll('.submenu-column.level-3, .submenu-column.level-4').forEach(function(c) {
                            c.classList.remove('submenu-column-open', 'active');
                            c.style.display = 'none';
                        });
                        iframeDoc.querySelectorAll('.chevron.rotate').forEach(function(c) { c.classList.remove('rotate'); });
                        var ov = iframeDoc.getElementById('overlay');
                        if (ov) ov.style.display = 'none';
                    }, 50);
                }, { passive: true });
                iframeWin.__spaMenuPatched = true;
            }

            if (!iframeWin.__spaObserverPatched) {
                var observer = new MutationObserver(function(mutations) {
                    mutations.forEach(function(m) {
                        m.addedNodes.forEach(function(node) {
                            if (!(node instanceof Element)) return;
                            var candidates = [node].concat(Array.from(node.querySelectorAll('[src],[href],[style]')));
                            candidates.forEach(function(el) {
                                if (el.hasAttribute && el.hasAttribute('src')) {
                                    var curS = el.getAttribute('src');
                                    var updS = rewriteAssetUrl(curS);
                                    if (updS && updS !== curS) el.setAttribute('src', updS);
                                }
                                if (el.hasAttribute && el.hasAttribute('href')) {
                                    var curH = el.getAttribute('href');
                                    var updH = rewriteAssetUrl(curH);
                                    if (updH && updH !== curH) el.setAttribute('href', updH);
                                }
                            });
                        });
                    });
                });
                observer.observe(iframeDoc.documentElement, { childList: true, subtree: true });
                iframeWin.__spaObserverPatched = true;
            }

            try {
                if (iframeWin.PRELOADED_IMAGES_BY_TAG && typeof iframeWin.PRELOADED_IMAGES_BY_TAG === 'object') {
                    Object.keys(iframeWin.PRELOADED_IMAGES_BY_TAG).forEach(function(k) {
                        var arr = Array.isArray(iframeWin.PRELOADED_IMAGES_BY_TAG[k]) ? iframeWin.PRELOADED_IMAGES_BY_TAG[k] : [];
                        iframeWin.PRELOADED_IMAGES_BY_TAG[k] = arr.filter(function(img) {
                            var src = String((img && img.src) || '').trim();
                            return src !== '' && !src.endsWith('/undefined') && src.indexOf('undefined/') === -1;
                        });
                    });
                }
            } catch (e) {}
        }

        function patchIframeDocumentPaths(iframe) {
            try {
                var iframeDoc = iframe.contentDocument;
                if (!iframeDoc) return;
                var iframeWin = iframe.contentWindow;
                if (!iframeWin) return;

                var walker = iframeDoc.createTreeWalker(iframeDoc.body || iframeDoc.documentElement, NodeFilter.SHOW_TEXT);
                var toClean = [];
                while (walker.nextNode()) {
                    var node = walker.currentNode;
                    if (!node || !node.nodeValue) continue;
                    if (node.nodeValue.indexOf('para no cerrar el bloque') !== -1) toClean.push(node);
                }
                toClean.forEach(function(n) {
                    n.nodeValue = n.nodeValue.replace(/.*para no cerrar el bloque\\)\\s*/g, '').trim();
                });

                var elementsWithSrc = iframeDoc.querySelectorAll('[src]');
                elementsWithSrc.forEach(function(el) {
                    var current = el.getAttribute('src');
                    var updated = rewriteAssetUrl(current);
                    if (updated && updated !== current) el.setAttribute('src', updated);
                });

                var elementsWithHref = iframeDoc.querySelectorAll('[href]');
                elementsWithHref.forEach(function(el) {
                    var current = el.getAttribute('href');
                    var updated = rewriteAssetUrl(current);
                    if (updated && updated !== current) el.setAttribute('href', updated);
                });

                var styleTags = iframeDoc.querySelectorAll('style');
                styleTags.forEach(function(styleEl) {
                    var css = styleEl.textContent || '';
                    if (!css) return;
                    var basePrefix = (DEPLOY_BASE || '/');
                    if (basePrefix.endsWith('/')) basePrefix = basePrefix.slice(0, -1);
                    var patched = css
                        .replace(/url\\((['"]?)\\/(?!\\/)/g, 'url($1' + basePrefix + '/')
                        .replace(/@import\\s+(['"])\\/(?!\\/)/g, '@import $1' + basePrefix + '/');
                    if (patched !== css) styleEl.textContent = patched;
                });

                var elementsWithStyle = iframeDoc.querySelectorAll('[style]');
                elementsWithStyle.forEach(function(el) {
                    var styleValue = el.getAttribute('style');
                    if (!styleValue) return;
                    var basePrefix = (DEPLOY_BASE || '/');
                    if (basePrefix.endsWith('/')) basePrefix = basePrefix.slice(0, -1);
                    var patched = styleValue.replace(/url\\((['"]?)\\/(?!\\/)/g, 'url($1' + basePrefix + '/');
                    if (patched !== styleValue) el.setAttribute('style', patched);
                });

                injectIframeFixes(iframeDoc, iframeWin);
            } catch (e) {
                // Ignore iframe access errors.
            }
        }
        
        // Mapeo de rutas a archivos HTML estáticos
        const routeMapping = ${JSON.stringify(
            Object.entries(mapping).reduce((acc, [key, value]) => {
                // Normalizar pagina_uri: si es '/' o vacío, usar '/', sino agregar '/' al inicio
                const route = (value.pagina_uri === '/' || value.pagina_uri === '') ? '/' : '/' + value.pagina_uri;
                acc[route] = value.fileName;
                // console.log('📝 Mapeando ruta:', route, '-> archivo:', value.fileName);
                return acc;
            }, {})
        , null, 2)};
        
        // console.log('🗺️ Route mapping completo:', routeMapping);

        // Página home por defecto
        const homePageFile = ${homePage ? `"${homePage.fileName}"` : 'null'};
        
        // console.log('🚀 Router inicializado. Protocolo:', window.location.protocol, 'Es archivo local:', isFileProtocol);
        // console.log('📋 Rutas disponibles:', Object.keys(routeMapping));

        // Función para cargar y mostrar una página HTML
        async function loadPage(route) {
            // console.log('🔍 loadPage llamado con ruta:', route);
            // console.log('📋 Mapping completo:', routeMapping);
            
            // Normalizar la ruta
            const normalizedRoute = route === '' ? '/' : (route.startsWith('/') ? route : '/' + route);
            // console.log('🔍 Ruta normalizada:', normalizedRoute);
            
            const fileName = routeMapping[normalizedRoute] || routeMapping['/'] || homePageFile;
            
            if (!fileName) {
                console.error('❌ No se encontró página para la ruta:', normalizedRoute);
                console.error('📋 Rutas disponibles en mapping:', Object.keys(routeMapping));
                console.error('📋 Home page file:', homePageFile);
                document.getElementById('app-container').innerHTML = '<h1>Página no encontrada: ' + normalizedRoute + '</h1><p>Rutas disponibles: ' + Object.keys(routeMapping).join(', ') + '</p>';
                document.getElementById('loading').style.display = 'none';
                return;
            }

            // console.log('✅ Archivo encontrado para ruta', normalizedRoute, ':', fileName);

            try {
                // Mostrar loading
                document.getElementById('loading').style.display = 'flex';
                
                const container = document.getElementById('app-container');
                if (!container) {
                    console.error('❌ Contenedor app-container no encontrado!');
                    document.getElementById('loading').style.display = 'none';
                    return;
                }

                container.innerHTML = '';
                const iframe = document.createElement('iframe');
                iframe.id = 'page-frame';
                // Evita HTML en caché del iframe tras regenerar (mismo nombre de archivo).
                iframe.src = fileName + (fileName.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now();
                iframe.style.width = '100%';
                iframe.style.height = '100vh';
                iframe.style.border = 'none';

                const loadingTimeout = setTimeout(function() {
                    const loadingEl = document.getElementById('loading');
                    if (loadingEl) loadingEl.style.display = 'none';
                }, 8000);

                let iframeLoaded = false;
                const hideLoader = function() {
                    if (iframeLoaded) return;
                    iframeLoaded = true;
                    clearTimeout(loadingTimeout);
                    const loadingEl = document.getElementById('loading');
                    if (loadingEl) loadingEl.style.display = 'none';
                };

                iframe.onload = function() {
                    patchIframeDocumentPaths(iframe);
                    hideLoader();
                };
                iframe.onerror = function() {
                    hideLoader();
                };

                container.appendChild(iframe);

                if (isFileProtocol) {
                    window.location.hash = normalizedRoute === '/' ? '' : normalizedRoute;
                } else {
                    try {
                        window.history.pushState({ route: normalizedRoute }, '', urlForPushState(normalizedRoute));
                    } catch (e) {
                        window.location.hash = normalizedRoute === '/' ? '' : normalizedRoute;
                    }
                }
            } catch (error) {
                console.error('Error cargando página:', error);
                document.getElementById('app-container').innerHTML = '<h1>Error cargando la página: ' + error.message + '</h1>';
                document.getElementById('loading').style.display = 'none';
            }
        }

        // Función para obtener la ruta actual
        function getCurrentRoute() {
            // Si estamos en file:// (archivo local), usar hash routing
            if (isFileProtocol) {
                if (window.location.hash && window.location.hash !== '#') {
                    const hashRoute = window.location.hash.substring(1);
                    // Asegurar que empiece con /
                    const normalizedRoute = hashRoute.startsWith('/') ? hashRoute : '/' + hashRoute;
                    if (routeMapping[normalizedRoute] || normalizedRoute === '/') {
                        return normalizedRoute;
                    }
                }
                return '/'; // Por defecto home para archivos locales
            }
            
            // Para HTTP/HTTPS, usar pathname normal
            // Primero intentar con hash (fallback)
            if (window.location.hash && window.location.hash !== '#') {
                const hashRoute = window.location.hash.substring(1);
                const normalizedRoute = hashRoute.startsWith('/') ? hashRoute : '/' + hashRoute;
                if (routeMapping[normalizedRoute] || normalizedRoute === '/') {
                    return normalizedRoute;
                }
            }
            
            const path = window.location.pathname;
            const internal = pathnameToInternalRoute(path);
            if (routeMapping[internal] || internal === '/') return internal;
            if (path === '/' || path === '/index.html' || path.endsWith('/index.html')) return '/';
            // Siempre preferir ruta interna (coincide con routeMapping); path completo rompe bajo subcarpeta
            return internal;
        }

        // Hacer loadPage disponible globalmente (aunque no funcionará desde iframe por seguridad)
        window.loadPage = loadPage;
        
        // Interceptar cambios en el hash (para cuando los enlaces dentro del iframe lo cambien)
        let lastHash = window.location.hash;
        window.addEventListener('hashchange', function(e) {
            const newHash = window.location.hash;
            if (newHash !== lastHash) {
                lastHash = newHash;
                const route = getCurrentRoute();
                // console.log('🔄 Hash cambió de', lastHash, 'a', newHash, '- Cargando ruta:', route);
                loadPage(route);
            }
        });
        
        // También verificar cambios en el hash periódicamente (por si hashchange no funciona)
        setInterval(function() {
            const currentHash = window.location.hash;
            if (currentHash !== lastHash) {
                lastHash = currentHash;
                const route = getCurrentRoute();
                // console.log('🔄 Hash detectado (polling):', currentHash, '- Cargando ruta:', route);
                loadPage(route);
            }
        }, 100); // Verificar cada 100ms
        
        // Interceptar clicks en enlaces para usar el router (usar delegación de eventos)
        document.addEventListener('click', function(e) {
            const link = e.target.closest('a');
            if (!link) return;
            
            // Obtener href del atributo directamente (más confiable)
            const hrefAttr = link.getAttribute('href');
            if (!hrefAttr || hrefAttr === '#' || hrefAttr.startsWith('javascript:') || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:')) {
                return; // No interceptar enlaces especiales
            }
            
            try {
                var route = hrefToInternalRoute(hrefAttr);
                if (route === null || route === undefined) return;
                
                // Verificar si la ruta existe en el mapping
                if (route) {
                    if (route === '') route = '/';
                    
                    // Verificar si la ruta existe en el mapping
                    if (routeMapping[route] || route === '/') {
                        // console.log('🔗 Router interceptando click:', hrefAttr, '->', route);
                        e.preventDefault();
                        e.stopPropagation();
                        
                        // Detectar archivos locales y actualizar hash antes de cargar
                        if (isFileProtocol) {
                            window.location.hash = route === '/' ? '' : route;
                        }
                        
                        loadPage(route);
                        return false;
                    } else {
                        // console.warn('⚠️ Ruta no encontrada en mapping:', route, 'Rutas disponibles:', Object.keys(routeMapping));
                    }
                }
            } catch (error) {
                console.error('❌ Error interceptando click:', error, 'href:', hrefAttr);
            }
        }, true); // Usar capture phase para interceptar antes que otros handlers
        
        // Escuchar mensajes del iframe usando postMessage (funciona con file://)
        window.addEventListener('message', function(e) {
            // Verificar que el mensaje sea para navegar
            if (e.data && e.data.type === 'navigate' && e.data.route) {
                // console.log('📨 Mensaje recibido del iframe para navegar:', e.data.route);
                var raw = String(e.data.route);
                var internalRoute = null;
                try {
                    if (raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0 || raw.indexOf('file://') === 0) {
                        internalRoute = hrefToInternalRoute(raw);
                    } else {
                        var normalizedRoute = raw === '' ? '/' : (raw.charAt(0) === '/' ? raw : '/' + raw);
                        internalRoute = pathnameToInternalRoute(normalizedRoute);
                    }
                } catch (err) { internalRoute = null; }
                if (internalRoute == null || internalRoute === '') internalRoute = '/';
                loadPage(internalRoute);
            }
        }, false);

        // Manejar navegación del navegador (back/forward)
        if (isFileProtocol) {
            // Para archivos locales, usar hashchange
            window.addEventListener('hashchange', function(e) {
                const route = getCurrentRoute();
                loadPage(route);
            });
        } else {
            // Para HTTP/HTTPS, usar popstate
            window.addEventListener('popstate', function(e) {
                const route = e.state ? e.state.route : getCurrentRoute();
                loadPage(route);
            });
        }

        // Cargar la página inicial cuando el DOM esté listo
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                const initialRoute = getCurrentRoute();
                // console.log('🚀 Cargando página inicial:', initialRoute);
                loadPage(initialRoute);
            });
        } else {
            // DOM ya está listo
            const initialRoute = getCurrentRoute();
            // console.log('🚀 Cargando página inicial (DOM listo):', initialRoute);
            loadPage(initialRoute);
        }
    </script>
</body>
</html>`;

        fs.writeFileSync(indexFile, indexHTML, 'utf8');

        // Apache: SPA fallback bajo subcarpeta (ajustar RewriteBase a la URL pública de esta app)
        const htaccessContent = `# CMS Morena — SPA estático (generado). Opcional: RewriteBase si Apache lo requiere (misma ruta pública que esta carpeta).
# Ej.: RewriteBase /paginas/dist_morena-nacional/app_${id_sysapp}/
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>
`;
        const htaccessFile = path.join(appDir, '.htaccess');
        try {
            fs.writeFileSync(htaccessFile, htaccessContent, 'utf8');
        } catch (e) {
            console.warn('[staticGenerator] No se pudo escribir .htaccess:', e.message);
        }

        // Compatibilidad producción: siempre replicar index/.htaccess en DATA_OUTPUT_PATH.
        writeToDataIfEnabled(id_sysapp, 'index.html', indexHTML);
        writeToDataIfEnabled(id_sysapp, '.htaccess', htaccessContent);
    } catch (error) {
        console.error('Error generando index.html principal:', error);
    }
}

/**
 * Datos para la lista de entradas (por instancia). Para HTML estático usamos detailUrl en cada entrada.
 */
async function getEntradasListData(idapp) {
    const { rows: pagEntrada, count: numrows } = await pagina.findAndCountAll({
        where: {
            fk_id_sysapp: idapp,
            fk_id_cat_type_pagina: 5,
            vigente: true
        },
        attributes: ['id_wb_pagina', 'nombre_pagina', 'contenido', 'contenido_alt', 'fk_id_file', 'f_reg', 'f_publicacion', 'url_safe', 'fk_id_sysapp'],
        order: [[Sequelize.fn('COALESCE', Sequelize.col('f_publicacion'), Sequelize.col('f_reg')), 'DESC']],
        limit: 500,
        offset: 0
    });
    const pageFileIds = [...new Set((pagEntrada || []).map(p => p.fk_id_file).filter(Boolean))];
    const fileById = await buildPaginaThumbFileMap(pageFileIds);
    const objPagEntrada = (pagEntrada || []).map(p => {
        const row = p.get ? p.get({ plain: true }) : p;
        const urlSafe = (row.url_safe || '').trim() || String(row.id_wb_pagina);
        const slug = urlSafe.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-').toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'entrada';
        const meta = row.fk_id_file ? fileById[row.fk_id_file] : null;
        let resolvedFilePath = null;
        let image_src = '';
        if (meta && meta.file_path) {
            const norm = normalizeStaticStorageAndFilePath(meta.storage_path || 'https://cdn.morena.app', meta.file_path);
            resolvedFilePath = norm.file_path;
            image_src = normalizeStaticMediaUrl((norm.storage_path || '') + (norm.file_path || ''));
        }
        return {
            ...row,
            file_path: resolvedFilePath,
            image_src,
            detailUrl: 'entradas/' + slug + '.html',
            allEntriesUrl: 'entradas.html'
        };
    });
    return {
        objPagEntrada,
        paginador: '',
        total_reg: numrows || 0,
        pagina_actual: 1,
        total_pag: 1,
        tokenTag: ''
    };
}

/**
 * Datos para el detalle de una entrada (por id_wb_pagina).
 */
async function getEntradaDetalleData(id_wb_pagina) {
    const pagEntrada = await pagina.findOne({
        where: { id_wb_pagina: id_wb_pagina, fk_id_cat_type_pagina: 5, vigente: true },
        attributes: ['id_wb_pagina', 'nombre_pagina', 'contenido', 'contenido_alt', 'f_reg', 'f_publicacion', 'fk_id_file'],
        include: [{
            model: filesModel.files,
            as: 'archivo',
            attributes: ['file_path'],
            required: false,
            include: [{
                model: storage_files,
                as: 'storage',
                required: false,
                attributes: ['storage_path']
            }]
        }]
    });
    return pagEntrada ? (pagEntrada.get ? pagEntrada.get({ plain: true }) : pagEntrada) : null;
}

/**
 * Datos para la página de regeneración (por instancia). Misma lógica que pagRegeneracionDetalle.
 */
async function getRegeneracionData(idapp) {
    const todasRegeneraciones = await rel_wb_tag_doc.findAll({
        where: { fk_id_cat_tag: 13, vigente: true },
        attributes: ['id_rel_wb_tag_doc', 'fk_id_wb_doc', 'fk_id_cat_bimestre', 'f_reg', 'anio'],
        order: [['anio', 'DESC'], ['f_reg', 'DESC']],
        raw: true
    });
    const idsDocumentos = todasRegeneraciones.map(rel => rel.fk_id_wb_doc);
    const documentos = await documento.findAll({
        where: {
            id_wb_doc: idsDocumentos.length ? idsDocumentos : [0],
            fk_id_sysapp: idapp,
            vigente: true
        },
        include: [{
            model: filesModel.files,
            as: 'archivodoc',
            include: [{ model: storage_files, as: 'storage' }]
        }],
        raw: true,
        nest: true
    });
    const idsDocInstancia = documentos.map(d => d.id_wb_doc);
    const relacionesInstancia = todasRegeneraciones.filter(rel => idsDocInstancia.includes(rel.fk_id_wb_doc));
    const relacionesImagenes = await rel_wb_tag_doc.findAll({
        where: { fk_id_cat_tag: 14, vigente: true },
        attributes: ['fk_id_wb_doc', 'fk_id_cat_bimestre', 'anio', 'f_reg'],
        order: [['f_reg', 'ASC']],
        raw: true
    });
    const idsImagenes = relacionesImagenes.map(rel => rel.fk_id_wb_doc);
    const imagenesDocs = await documento.findAll({
        where: {
            id_wb_doc: idsImagenes.length ? idsImagenes : [0],
            fk_id_sysapp: idapp,
            vigente: true
        },
        include: [{
            model: filesModel.files,
            as: 'archivodoc',
            include: [{ model: storage_files, as: 'storage' }]
        }],
        raw: true,
        nest: true
    });
    const regeneracionesPorAnio = {};
    const imagenesUsadas = new Set(); // cada imagen solo se asigna a una regeneración
    relacionesInstancia
        .slice()
        .sort((a, b) => (b.anio - a.anio) || (new Date(a.f_reg).getTime() - new Date(b.f_reg).getTime()))
        .forEach(rel => {
            const anio = rel.anio;
            if (!regeneracionesPorAnio[anio]) regeneracionesPorAnio[anio] = [];
            const doc = documentos.find(d => d.id_wb_doc === rel.fk_id_wb_doc);
            const tPdf = new Date(rel.f_reg).getTime();
            const candidatas = relacionesImagenes
                .filter(img => img.fk_id_cat_bimestre === rel.fk_id_cat_bimestre && img.anio === anio && !imagenesUsadas.has(img.fk_id_wb_doc))
                .map(img => ({ ...img, t: new Date(img.f_reg).getTime() }));
            const imgRel = candidatas
                .filter(c => c.t >= tPdf)
                .sort((a, b) => a.t - b.t)[0]
                || candidatas.sort((a, b) => b.t - a.t)[0];
            if (imgRel) imagenesUsadas.add(imgRel.fk_id_wb_doc);
            const imgDoc = imgRel ? imagenesDocs.find(imgD => imgD.id_wb_doc === imgRel.fk_id_wb_doc) : null;
            if (doc) {
                regeneracionesPorAnio[anio].push({
                    nombre_doc: doc.nombre,
                    archivoDoc: doc.archivodoc,
                    imagenCard: imgDoc && imgDoc.archivodoc ? imgDoc.archivodoc : null,
                    bimestre: rel.fk_id_cat_bimestre
                });
            }
        });
    const añosDisponibles = [...new Set(relacionesInstancia.map(r => r.anio).filter(Boolean))].sort((a, b) => b - a);
    const anioActual = añosDisponibles.length > 0 ? añosDisponibles[0] : null;
    return { regeneracionesPorAnio, anioActual, añosDisponibles: añosDisponibles };
}

/**
 * Genera y guarda el HTML estático de la lista de entradas (por instancia).
 */
async function generateAndSaveStaticHTMLForEntradasList(objapp) {
    const viewsPath = VIEWS_PATH;
    const staticAppData = await enrichAppForStatic(objapp);
    const menuData = await obtenerMenuData(objapp.id_sysapp);
    const classtop = objapp.fk_id_sysapp_type === 2 ? 'top_prim' : 'top_sec';
    const menuHTML = await renderizarMenuEstatico(menuData, 'entradas', objapp.id_sysapp);
    const footerHTML = await renderizarFooterEstatico(objapp.id_sysapp);
    const listData = await getEntradasListData(objapp.id_sysapp);
    const viewData = {
        dataapp: staticAppData,
        datapagina: { nombre_pagina: 'Entradas' },
        classtop,
        menuData,
        menuHTML, // Menú estático
        footerHTML,
        assetsPrefix: 'assets/',
        ...listData
    };
    // Render de la vista y embebido de CSS sin tocar el resto del HTML
    let htmlContent = await renderStaticViewCustom(viewData, viewsPath, 'publics/entradas.ejs');
    htmlContent = await embedAssetsCssForHtml(htmlContent);
    const pagina_uri = 'entradas';
    const fileName = getStableFileNameForVirtual(pagina_uri);
    return saveStaticHTMLVirtual(htmlContent, objapp, 'entradas_list', pagina_uri, fileName);
}

/**
 * Genera y guarda el HTML estático del detalle de una entrada (por instancia).
 */
async function generateAndSaveStaticHTMLForEntradaDetalle(objapp, id_wb_pagina, url_safe) {
    const viewsPath = VIEWS_PATH;
    const staticAppData = await enrichAppForStatic(objapp);
    const objPagEntrada = await getEntradaDetalleData(id_wb_pagina);
    if (!objPagEntrada) return null;
    const slug = (url_safe || '').trim() || String(id_wb_pagina);
    const slugNorm = slug.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-').toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'entrada';
    const menuData = await obtenerMenuData(objapp.id_sysapp);
    const classtop = objapp.fk_id_sysapp_type === 2 ? 'top_prim' : 'top_sec';
    const menuHTML = await renderizarMenuEstatico(menuData, 'entradas/' + slugNorm, objapp.id_sysapp);
    const footerHTML = await renderizarFooterEstatico(objapp.id_sysapp);
    const viewData = {
        dataapp: staticAppData,
        datapagina: { nombre_pagina: objPagEntrada.nombre_pagina || 'Entrada' },
        classtop,
        menuData,
        menuHTML, // Menú estático
        footerHTML,
        assetsPrefix: 'assets/',
        objPagEntrada
    };
    // Render de la vista y embebido de CSS sin tocar el resto del HTML
    let htmlContent = await renderStaticViewCustom(viewData, viewsPath, 'publics/entradas_detalle.ejs');
    htmlContent = await embedAssetsCssForHtml(htmlContent);
    const pagina_uri = 'entradas/' + slugNorm;
    const fileName = getStableFileNameForVirtual(pagina_uri);
    return saveStaticHTMLVirtual(htmlContent, objapp, 'entrada_' + id_wb_pagina, pagina_uri, fileName);
}

/**
 * Genera y guarda el HTML estático de la página de regeneración (por instancia).
 */
async function generateAndSaveStaticHTMLForRegeneracion(objapp) {
    const viewsPath = VIEWS_PATH;
    const staticAppData = await enrichAppForStatic(objapp);
    const { regeneracionesPorAnio, anioActual, añosDisponibles } = await getRegeneracionData(objapp.id_sysapp);
    const menuData = await obtenerMenuData(objapp.id_sysapp);
    const classtop = objapp.fk_id_sysapp_type === 2 ? 'top_prim' : 'top_sec';
    const menuHTML = await renderizarMenuEstatico(menuData, 'regeneracion', objapp.id_sysapp);
    const footerHTML = await renderizarFooterEstatico(objapp.id_sysapp);
    const viewData = {
        dataapp: staticAppData,
        datapagina: { nombre_pagina: 'Regeneración' },
        classtop,
        menuData,
        menuHTML, // Menú estático
        footerHTML,
        assetsPrefix: 'assets/',
        regeneracionesPorAnio,
        anioActual,
        añosDisponibles
    };
    let htmlContent = await renderStaticViewCustom(viewData, viewsPath, 'publics/regeneracion_detalle.ejs');
    htmlContent = await processResources(htmlContent, viewsPath);
    htmlContent = await obfuscateInlineJS(htmlContent);
    htmlContent = minify(htmlContent, {
        removeAttributeQuotes: true,
        collapseWhitespace: true,
        removeComments: true,
        minifyJS: false,
        minifyCSS: true,
        collapseBooleanAttributes: true,
        removeRedundantAttributes: true,
        useShortDoctype: false,
        removeEmptyAttributes: true,
        removeOptionalTags: true,
        removeScriptTypeAttributes: true,
        removeStyleLinkTypeAttributes: true
    });
    const pagina_uri = 'regeneracion';
    const fileName = getStableFileNameForVirtual(pagina_uri);
    return saveStaticHTMLVirtual(htmlContent, objapp, 'regeneracion', pagina_uri, fileName);
}

/**
 * Función principal para generar y guardar HTML estático
 */
async function generateAndSaveStaticHTML(objapp, objpagina, pagina_uri, type_uri) {
    console.log('[staticGenerator] generateAndSaveStaticHTML llamado:', { id_sysapp: objapp?.id_sysapp, id_wb_pagina: objpagina?.id_wb_pagina, pagina_uri, type_uri });
    try {
        // Siempre preferir id_wb_pagina: getDataPagina(uri) filtra publicada:true y puede devolver OTRA fila
        // con el mismo url_safe (p. ej. borrador vs publicada, o varias coincidencias + ORDER BY id DESC),
        // generando HTML "un paso atrás" respecto a lo que el editor acaba de guardar/publicar.
        let paginaCompleta = objpagina;
        const idPag =
            objpagina &&
            (objpagina.id_wb_pagina != null
                ? objpagina.id_wb_pagina
                : objpagina.dataValues && objpagina.dataValues.id_wb_pagina);

        if (idPag != null) {
            console.log('[staticGenerator] generateAndSaveStaticHTML cargando por id_wb_pagina:', idPag);
            const porId = await pagina.getDataPaginaID(idPag);
            if (porId && porId.length > 0) {
                paginaCompleta = porId[0].get ? porId[0].get({ plain: true }) : porId[0];
                if (paginaCompleta.fk_id_sysapp !== objapp.id_sysapp) {
                    throw new Error('La página no corresponde a la instancia indicada');
                }
                console.log('[staticGenerator] generateAndSaveStaticHTML por id, secciones:', paginaCompleta.secciones?.length ?? 0);
            }
        }

        if (!paginaCompleta.secciones || paginaCompleta.secciones.length === 0) {
            console.log('[staticGenerator] generateAndSaveStaticHTML fallback por URI (sin secciones o sin id)...');
            const paginas = await pagina.getDataPagina(
                objapp.id_sysapp,
                pagina_uri || objpagina.url_safe || '/',
                type_uri || objpagina.fk_id_cat_type_pagina || 2
            );

            if (paginas && paginas.length > 0) {
                paginaCompleta = paginas[0].get ? paginas[0].get({ plain: true }) : paginas[0];
                console.log('[staticGenerator] generateAndSaveStaticHTML página por URI, secciones:', paginaCompleta.secciones?.length ?? 0);
            } else if (!paginaCompleta || !paginaCompleta.id_wb_pagina) {
                console.error('[staticGenerator] generateAndSaveStaticHTML página no encontrada');
                throw new Error('Página no encontrada');
            }
        }

        const finalPaginaUri = pagina_uri || paginaCompleta.url_safe || '/';
        const finalTypeUri = type_uri || paginaCompleta.fk_id_cat_type_pagina || 2;
        console.log('[staticGenerator] generateAndSaveStaticHTML generando HTML...', { finalPaginaUri, finalTypeUri });

        const htmlContent = await generateStaticHTML(
            objapp,
            paginaCompleta,
            finalPaginaUri,
            finalTypeUri
        );
        console.log('[staticGenerator] generateAndSaveStaticHTML HTML generado, longitud:', htmlContent?.length ?? 0);

        const filePath = await saveStaticHTML(
            htmlContent,
            objapp,
            paginaCompleta,
            finalPaginaUri
        );
        console.log('[staticGenerator] generateAndSaveStaticHTML guardado en:', filePath);

        return filePath;
    } catch (error) {
        console.error('[staticGenerator] Error en generateAndSaveStaticHTML:', error);
        throw error;
    }
}

module.exports = {
    generateStaticHTML,
    generateAndSaveStaticHTML,
    deleteStaticHTML,
    saveStaticHTML,
    saveStaticHTMLVirtual,
    deleteStaticHTMLVirtual,
    getStablePageFileName,
    getStableFileNameForVirtual,
    buscarHTMLEstatico,
    getDistDirBase,
    getStaticPreviewWebPathPrefix,
    slugifyInstanceName,
    slugifyPaginaUri,
    generateAndSaveStaticHTMLForEntradasList,
    generateAndSaveStaticHTMLForEntradaDetalle,
    generateAndSaveStaticHTMLForRegeneracion
};
