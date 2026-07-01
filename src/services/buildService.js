const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pagina, seccion, columna, componente, tipoComponente } = require('../models/paginasModel');
const { renderComponente } = require('../controllers/publicController');
const menuModel = require('../models/menuModel');
const { Op } = require('sequelize');

/**
 * Servicio para generar builds estáticos de páginas publicadas
 * Similar a como React genera archivos estáticos en dist/
 */
class BuildService {
    constructor() {
        // Determinar ruta según PRODUCCION
        const isProduccion = process.env.PRODUCCION === 'true';
        
        if (isProduccion) {
            // En producción, usar carpeta externa (puedes configurar la ruta)
            // Por defecto usa una carpeta en el directorio padre del proyecto
            this.distPath = process.env.STATIC_BUILD_PATH || 
                          path.join(__dirname, '../../../static_builds');
        } else {
            // En desarrollo, usar carpeta dist local
            this.distPath = path.join(__dirname, '../../dist');
        }
        
        // Ruta base para las vistas (desde app/src/services -> app/src/views)
        this.viewsPath = path.join(__dirname, '../views');
        this.isProduccion = isProduccion;
        this.ensureDistDirectory();
    }

    /**
     * Asegura que el directorio dist existe
     */
    ensureDistDirectory() {
        if (!fs.existsSync(this.distPath)) {
            fs.mkdirSync(this.distPath, { recursive: true });
        }
    }

    /**
     * Genera un hash SHA256 de la URL completa para el nombre del archivo
     * @param {string} fullUrl - URL completa (host + path)
     * @returns {string} Hash SHA256
     */
    generateHash(fullUrl) {
        return crypto.createHash('sha256').update(fullUrl).digest('hex');
    }

    /**
     * Genera la ruta del archivo estático para una página usando hash
     * Organiza por app y ruta para mejor estructura
     * @param {string} fullUrl - URL completa (host + path) para generar el hash
     * @param {number} idApp - ID de la aplicación (opcional, para organización)
     * @param {string} urlSafe - URL safe de la página (opcional, para organización)
     * @returns {string} Ruta del archivo estático
     */
    getStaticFilePath(fullUrl, idApp = null, urlSafe = null) {
        const hash = this.generateHash(fullUrl);
        const fileName = `${hash}.html`;
        
        // Organizar por app y ruta si se proporcionan
        if (idApp && urlSafe) {
            // Limpiar urlSafe para usar como nombre de carpeta
            const safeFolderName = urlSafe === '/' ? 'index' : urlSafe.replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
            const appFolder = path.join(this.distPath, `app_${idApp}`);
            const routeFolder = path.join(appFolder, safeFolderName);
            
            // Asegurar que las carpetas existan
            if (!fs.existsSync(routeFolder)) {
                fs.mkdirSync(routeFolder, { recursive: true });
            }
            
            return path.join(routeFolder, fileName);
        }
        
        // Fallback: guardar en raíz si no hay info de app/ruta
        return path.join(this.distPath, fileName);
    }

    /**
     * Obtiene la ruta del archivo estático desde una URL
     * @param {string} fullUrl - URL completa
     * @returns {string} Ruta del archivo
     */
    getFilePathFromUrl(fullUrl) {
        return this.getStaticFilePath(fullUrl);
    }

    /**
     * Obtiene los datos del menú para una aplicación
     * @param {number} idApp - ID de la aplicación
     * @returns {Promise<Array>} Datos del menú
     */
    async obtenerMenuData(idApp) {
        try {
            const menuId = await menuModel.menu.findOne({
                where: {
                    fk_id_sysapp: idApp,
                    vigente: true,
                },
                raw: true,
            });

            if (!menuId) {
                return [];
            }

            return await this.obtenerMenuPorNivel(menuId.id_wb_menu, null);
        } catch (error) {
            console.error('Error obteniendo menú:', error);
            return [];
        }
    }

    /**
     * Obtiene el menú por nivel recursivamente
     * @param {number} menu_id - ID del menú
     * @param {number|null} fk_id_padre - ID del padre
     * @returns {Promise<Array>} Array de items del menú
     */
    async obtenerMenuPorNivel(menu_id, fk_id_padre = null) {
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
            link.submenus = await this.obtenerMenuPorNivel(menu_id, link.id_wb_menu_link);
        }

        return hijos;
    }

    /**
     * Renderiza el menú en HTML estático
     * @param {Array} menuData - Datos del menú
     * @returns {string} HTML del menú renderizado
     */
    renderMenuHTML(menuData) {
        if (!menuData || menuData.length === 0) {
            return '<li><ul class="submenu-imagen"><li><img src="/assets/img/img-menu-responsive.png" alt="Menú Imagen"></li></ul></li>';
        }

        let html = '<li><ul class="submenu-imagen"><li><img src="/assets/img/img-menu-responsive.png" alt="Menú Imagen"></li></ul></li>';
        
        menuData.forEach(itemNivel1 => {
            const tieneSubmenus = itemNivel1.submenus && itemNivel1.submenus.length > 0;
            const href = tieneSubmenus ? '#' : (itemNivel1.url_link || '#');
            const classes = tieneSubmenus ? 'menu-link has-submenu' : 'menu-link';
            const dataTarget = tieneSubmenus ? ` data-target="submenu-${itemNivel1.id_wb_menu_link}"` : '';

            let linkNivel1 = `<a href="${href}" class="${classes}"${dataTarget}>`;
            linkNivel1 += `<span>${itemNivel1.nombre}</span>`;
            if (tieneSubmenus) {
                linkNivel1 += `<i class="fa-solid fa-chevron-down chevron"></i>`;
            }
            linkNivel1 += `</a>`;
            
            html += `<li>${linkNivel1}`;
            if (tieneSubmenus) {
                html += `<div class="submenu-container" id="submenu-${itemNivel1.id_wb_menu_link}">`;
                html += `<div class="submenu-content">`;
                const imgUrl = itemNivel1.url_imagen || '/assets/img/img-menu.png';
                html += `<ul class="submenu-column level-0"><li><img class="submenuImg" src="${imgUrl}" alt="${itemNivel1.nombre}"></li></ul>`;
                html += this.renderSubmenusHTML(itemNivel1.submenus);
                html += `</div></div>`;
            }
            html += `</li>`;
        });

        return html;
    }

    /**
     * Renderiza submenús recursivamente
     * @param {Array} items - Items del menú
     * @param {number} currentLevel - Nivel actual
     * @returns {string} HTML de submenús
     */
    renderSubmenusHTML(items, currentLevel = 2) {
        if (!items || items.length === 0) return '';
        
        let html = `<ul class="submenu-column level-${currentLevel}">`;
        
        items.forEach(item => {
            const isToggle = item.submenus && item.submenus.length > 0;
            const href = item.url_link || '#';
            const classes = isToggle ? 'menu-link has-submenu' : 'menu-link';
            const dataTarget = isToggle ? ` data-target="submenu-${item.id_wb_menu_link}"` : '';
            
            let linkContent = `<a href="${href}" class="${classes}"${dataTarget}>`;
            
            if (currentLevel <= 2) {
                linkContent += `<img src="../assets/img/arrow-down-solid.svg" class="menuicon">`;
            }
            
            linkContent += `<p class="unopar">${item.nombre}</p>`;
            
            if (isToggle) {
                linkContent += `<i class="fa-solid fa-chevron-right chevron"></i>`;
            }
            linkContent += `</a>`;
            
            html += `<li class="imgMenu">`;
            html += linkContent;
            html += `</li>`;
        });

        html += `</ul>`;
        
        // Renderizar niveles siguientes
        items.forEach(item => {
            if (item.submenus && item.submenus.length > 0) {
                html += this.renderSubmenusHTML(item.submenus, currentLevel + 1);
            }
        });
        
        return html;
    }

    /**
     * Genera el HTML estático de una página
     * @param {Object} objapp - Objeto de la aplicación
     * @param {Object} objpagina - Objeto de la página
     * @param {string} paginaUri - URI de la página
     * @param {number} typeUri - Tipo de URI
     * @returns {Promise<string>} HTML renderizado
     */
    async generateStaticHTML(objapp, objpagina, paginaUri, typeUri) {
        try {
            console.log(`📦 [generateStaticHTML] Iniciando generación de HTML estático`);
            console.log(`   - paginaUri: ${paginaUri}`);
            console.log(`   - typeUri: ${typeUri}`);
            console.log(`   - objpagina tiene secciones: ${objpagina && objpagina.secciones ? 'SÍ' : 'NO'}`);
            console.log(`   - Cantidad de secciones: ${objpagina && objpagina.secciones ? objpagina.secciones.length : 0}`);
            
            // Verificar estructura de objpagina ANTES de renderizar
            if (!objpagina || !objpagina.secciones || objpagina.secciones.length === 0) {
                console.error(`❌ ERROR CRÍTICO: objpagina NO tiene secciones!`);
                console.error(`   - objpagina: ${objpagina ? 'existe' : 'NO existe'}`);
                if (objpagina) {
                    console.error(`   - objpagina keys: ${Object.keys(objpagina).join(', ')}`);
                    console.error(`   - objpagina.dataValues: ${objpagina.dataValues ? Object.keys(objpagina.dataValues).join(', ') : 'NO tiene'}`);
                }
                throw new Error('objpagina no tiene secciones - no se puede generar HTML estático');
            }
            
            // Contar componentes totales
            let totalComponentes = 0;
            objpagina.secciones.forEach((sec, idx) => {
                const numCols = sec.columnas ? sec.columnas.length : 0;
                let compsEnSec = 0;
                if (sec.columnas) {
                    sec.columnas.forEach(col => {
                        if (col.componentes) {
                            compsEnSec += col.componentes.length;
                            totalComponentes += col.componentes.length;
                        }
                    });
                }
                console.log(`   - Sección ${idx}: ${numCols} columnas, ${compsEnSec} componentes`);
            });
            console.log(`   - Total componentes en página: ${totalComponentes}`);
            
            // Renderizar todos los componentes antes de generar el HTML
            const componentesRenderizados = await this.renderAllComponents(
                objpagina,
                objapp
            );

            // Obtener datos del menú
            const menuData = await this.obtenerMenuData(objapp.id_sysapp);
            const menuHTML = this.renderMenuHTML(menuData);

            // Preparar datos para el template
            const classtop = objapp.fk_id_sysapp_type === 2 ? 'top_prim' : 'top_sec';
            const templateData = {
                dataapp: objapp,
                datapagina: objpagina,
                pagina: paginaUri,
                classtop,
                edit: 0,
                menuData: menuData,
                menuHTML: menuHTML,
            };

            // Determinar qué template usar
            let templatePath;
            if (objpagina.dataValues.fk_id_cat_type_pagina === 5 || typeUri === 5) {
                templatePath = path.join(
                    __dirname,
                    '../views/publics/entradas.ejs'
                );
                templateData.objPagEntrada = [];
            } else {
                templatePath = path.join(
                    __dirname,
                    '../views/publics/index.ejs'
                );
            }

            // Configurar las rutas para que EJS pueda resolver includes
            const publicsPath = path.join(this.viewsPath, 'publics');
            
            // Leer el template manualmente y renderizar includes
            const templateContent = fs.readFileSync(templatePath, 'utf8');
            console.log(`📦 Template leído, longitud: ${templateContent.length}`);
            console.log(`   - Tiene include header: ${templateContent.includes("include('partials/header')")}`);
            console.log(`   - Tiene include visorpaginas: ${templateContent.includes("include('partials/visorpaginas')")}`);
            console.log(`   - Tiene include footer: ${templateContent.includes("include('partials/footer')")}`);
            
            // Renderizar includes manualmente antes de renderizar el template principal
            let processedTemplate = templateContent;
            
            // Renderizar menu primero (se necesita en header)
            const menuPath = path.join(publicsPath, 'partials/menu.ejs');
            let menuRendered = '';
            if (fs.existsSync(menuPath)) {
                const menuContent = fs.readFileSync(menuPath, 'utf8');
                // Reemplazar la función obtenerMenu() con el menú pre-renderizado
                const menuContentProcessed = menuContent.replace(
                    /obtenerMenu\(\);/g,
                    `// Menú pre-renderizado: ${menuHTML}`
                );
                menuRendered = ejs.render(menuContentProcessed, {
                    ...templateData,
                    menuHTML: menuHTML
                }, {
                    filename: menuPath,
                    views: [publicsPath, this.viewsPath]
                });
            }
            
            // Renderizar header (que incluye menu)
            const headerPath = path.join(publicsPath, 'partials/header.ejs');
            if (fs.existsSync(headerPath)) {
                let headerContent = fs.readFileSync(headerPath, 'utf8');
                // Reemplazar el include de menu con el menú renderizado
                headerContent = headerContent.replace(
                    /<%- include\('menu'\); %>/g,
                    menuRendered
                );
                const headerRendered = ejs.render(headerContent, templateData, {
                    filename: headerPath,
                    views: [publicsPath, this.viewsPath]
                });
                processedTemplate = processedTemplate.replace(
                    /<%- include\('partials\/header'\); %>/g,
                    headerRendered
                );
            }
            
            // Renderizar visorpaginas (DEBE renderizarse DESPUÉS de que los componentes estén renderizados)
            const visorpaginasPath = path.join(publicsPath, 'partials/visorpaginas.ejs');
            let visorpaginasRendered = '';
            if (fs.existsSync(visorpaginasPath)) {
                const visorpaginasContent = fs.readFileSync(visorpaginasPath, 'utf8');
                console.log(`📦 Renderizando visorpaginas...`);
                console.log(`   - Secciones en datapagina: ${objpagina.secciones ? objpagina.secciones.length : 0}`);
                
                // Verificar que datapagina tenga secciones
                if (!objpagina.secciones || objpagina.secciones.length === 0) {
                    console.warn(`⚠️  ADVERTENCIA: datapagina no tiene secciones!`);
                } else {
                    // Contar componentes totales
                    let totalComponentes = 0;
                    objpagina.secciones.forEach(sec => {
                        if (sec.columnas) {
                            sec.columnas.forEach(col => {
                                if (col.componentes) {
                                    totalComponentes += col.componentes.length;
                                }
                            });
                        }
                    });
                    console.log(`   - Total componentes en página: ${totalComponentes}`);
                }
                
                visorpaginasRendered = ejs.render(visorpaginasContent, templateData, {
                    filename: visorpaginasPath,
                    views: [publicsPath, this.viewsPath]
                });
                
                console.log(`   - visorpaginas renderizado, longitud: ${visorpaginasRendered.length}`);
                console.log(`   - Tiene contPub: ${visorpaginasRendered.includes('contPub')}`);
                console.log(`   - Tiene pub_componente: ${visorpaginasRendered.includes('pub_componente')}`);
                
                if (visorpaginasRendered.length === 0) {
                    console.error(`❌ ERROR: visorpaginas se renderizó vacío!`);
                }
                
                // Reemplazar en el template - probar ambos formatos de include
                const beforeReplace1 = processedTemplate.includes("include('partials/visorpaginas')");
                const beforeReplace2 = processedTemplate.includes('include("partials/visorpaginas")');
                const beforeReplace3 = processedTemplate.includes("include('partials/visorpaginas')");
                
                // Reemplazar con diferentes formatos posibles
                processedTemplate = processedTemplate.replace(
                    /<%- include\('partials\/visorpaginas'\); %>/g,
                    visorpaginasRendered
                );
                processedTemplate = processedTemplate.replace(
                    /<%- include\("partials\/visorpaginas"\); %>/g,
                    visorpaginasRendered
                );
                processedTemplate = processedTemplate.replace(
                    /<% include\('partials\/visorpaginas'\); %>/g,
                    visorpaginasRendered
                );
                
                const afterReplace = processedTemplate.includes("include('partials/visorpaginas')") || 
                                    processedTemplate.includes('include("partials/visorpaginas")');
                
                console.log(`   - Reemplazo realizado: ${beforeReplace1 || beforeReplace2} -> ${!afterReplace}`);
                console.log(`   - processedTemplate ahora tiene contPub: ${processedTemplate.includes('contPub')}`);
                console.log(`   - processedTemplate ahora tiene pub_componente: ${processedTemplate.includes('pub_componente')}`);
                
                if (afterReplace) {
                    console.error(`❌ ERROR: El include de visorpaginas NO se reemplazó!`);
                    console.error(`   - processedTemplate aún contiene el include`);
                }
            } else {
                console.error(`❌ No se encontró visorpaginas en: ${visorpaginasPath}`);
            }
            
            // Renderizar footer
            const footerPath = path.join(publicsPath, 'partials/footer.ejs');
            if (fs.existsSync(footerPath)) {
                const footerContent = fs.readFileSync(footerPath, 'utf8');
                const footerRendered = ejs.render(footerContent, templateData, {
                    filename: footerPath,
                    views: [publicsPath, this.viewsPath]
                });
                processedTemplate = processedTemplate.replace(
                    /<%- include\('partials\/footer'\); %>/g,
                    footerRendered
                );
            }
            
            // Verificar que processedTemplate tenga visorpaginas antes de renderizar
            console.log(`📦 Verificando processedTemplate antes de render final:`);
            console.log(`   - Tiene include visorpaginas: ${processedTemplate.includes("include('partials/visorpaginas')")}`);
            console.log(`   - Tiene contPub: ${processedTemplate.includes('contPub')}`);
            console.log(`   - Tiene pub_seccion: ${processedTemplate.includes('pub_seccion')}`);
            console.log(`   - Tiene pub_componente: ${processedTemplate.includes('pub_componente')}`);
            console.log(`   - Longitud processedTemplate: ${processedTemplate.length}`);
            
            // Si processedTemplate NO tiene contPub, hay un problema grave
            if (!processedTemplate.includes('contPub')) {
                console.error(`❌ ERROR CRÍTICO: processedTemplate NO tiene contPub después de reemplazar includes!`);
                console.error(`   - Esto significa que visorpaginas NO se inyectó correctamente`);
                console.error(`   - Buscando fragmentos del template para debug...`);
                const visorpaginasIndex = processedTemplate.indexOf('visorpaginas');
                if (visorpaginasIndex >= 0) {
                    console.error(`   - Encontrado 'visorpaginas' en posición ${visorpaginasIndex}`);
                    console.error(`   - Fragmento: ${processedTemplate.substring(visorpaginasIndex - 50, visorpaginasIndex + 100)}`);
                }
            }
            
            // Renderizar el template completo
            let html = ejs.render(processedTemplate, templateData, {
                filename: templatePath,
                views: [publicsPath, this.viewsPath]
            });
            
            console.log(`📦 Después de render final:`);
            console.log(`   - HTML tiene contPub: ${html.includes('contPub')}`);
            console.log(`   - HTML tiene pub_seccion: ${html.includes('pub_seccion')}`);
            console.log(`   - HTML tiene pub_componente: ${html.includes('pub_componente')}`);
            console.log(`   - Longitud HTML final: ${html.length}`);
            
            // Si el HTML final NO tiene contPub, lanzar error
            if (!html.includes('contPub')) {
                console.error(`❌ ERROR CRÍTICO: El HTML final NO tiene contPub!`);
                console.error(`   - El contenido de la página NO se está renderizando`);
                throw new Error('El HTML generado no contiene contPub - visorpaginas no se renderizó correctamente');
            }

            // Reemplazar los placeholders de componentes con HTML renderizado
            console.log(`📦 Componentes renderizados: ${componentesRenderizados.length}`);
            if (componentesRenderizados.length > 0) {
                console.log(`   - Primer componente idcypher: ${componentesRenderizados[0].idcypher ? componentesRenderizados[0].idcypher.substring(0, 20) + '...' : 'N/A'}`);
            }
            
            console.log(`📦 ANTES de injectComponentHTML:`);
            console.log(`   - HTML length: ${html.length}`);
            console.log(`   - Tiene contPub: ${html.includes('contPub')}`);
            console.log(`   - Tiene pub_componente: ${html.includes('pub_componente')}`);
            
            html = this.injectComponentHTML(html, componentesRenderizados);
            
            console.log(`📦 DESPUÉS de injectComponentHTML:`);
            console.log(`   - HTML length: ${html.length}`);
            console.log(`   - Tiene contPub: ${html.includes('contPub')}`);
            console.log(`   - Tiene pub_componente: ${html.includes('pub_componente')}`);
            
            // Inyectar el menú renderizado en el HTML
            console.log(`📦 Menú HTML length: ${menuHTML.length}`);
            console.log(`📦 ANTES de injectMenuHTML:`);
            console.log(`   - HTML length: ${html.length}`);
            console.log(`   - Tiene contPub: ${html.includes('contPub')}`);
            
            html = this.injectMenuHTML(html, menuHTML);
            
            console.log(`📦 DESPUÉS de injectMenuHTML:`);
            console.log(`   - HTML length: ${html.length}`);
            console.log(`   - Tiene contPub: ${html.includes('contPub')}`);
            
            // Verificar que el HTML tenga el contenido esperado
            const hasContPub = html.includes('contPub');
            const hasMenuList = html.includes('menu-list');
            const hasPubComponente = html.includes('pub_componente');
            const componentCount = (html.match(/pub_componente/g) || []).length;
            console.log(`📦 HTML generado - tiene contPub: ${hasContPub}, tiene menu-list: ${hasMenuList}, tiene pub_componente: ${hasPubComponente} (${componentCount} instancias)`);
            
            if (!hasContPub) {
                console.error(`❌ ERROR: El HTML generado NO tiene contPub!`);
                console.error(`   - Esto significa que visorpaginas no se renderizó correctamente`);
            }
            if (hasPubComponente && componentCount > 0) {
                console.warn(`⚠️  ADVERTENCIA: El HTML tiene ${componentCount} divs pub_componente sin reemplazar!`);
                console.warn(`   - Los componentes no se están inyectando correctamente`);
            }

            return html;
        } catch (error) {
            console.error('Error generando HTML estático:', error);
            throw error;
        }
    }

    /**
     * Renderiza todos los componentes de una página
     * @param {Object} objpagina - Objeto de la página
     * @param {Object} objapp - Objeto de la aplicación
     * @returns {Promise<Array>} Array de componentes renderizados con su idcypher
     */
    async renderAllComponents(objpagina, objapp) {
        const componentesRenderizados = [];

        if (!objpagina.secciones) {
            return componentesRenderizados;
        }

        // Iterar en el mismo orden que aparecen en el HTML
        for (const seccion of objpagina.secciones || []) {
            for (const columna of seccion.columnas || []) {
                for (const componente of columna.componentes || []) {
                    try {
                        const tabla = componente.tipoComponente?.dataValues?.table_componente;
                        const idComp = componente.dataValues.id_wb_pag_componente;
                        const idcypher = componente.idcypher || '';

                        if (tabla && idComp) {
                            const resultado = await renderComponente(
                                tabla,
                                idComp,
                                objapp.id_sysapp
                            );

                            if (resultado && resultado.rend) {
                                componentesRenderizados.push({
                                    idcypher: idcypher,
                                    html: resultado.rend,
                                });
                            } else {
                                // Agregar placeholder si no se pudo renderizar
                                componentesRenderizados.push({
                                    idcypher: idcypher,
                                    html: '<!-- Componente no renderizado -->',
                                });
                            }
                        }
                    } catch (error) {
                        console.error(
                            `Error renderizando componente ${componente.dataValues.id_wb_pag_componente}:`,
                            error
                        );
                        // Agregar placeholder en caso de error
                        componentesRenderizados.push({
                            idcypher: componente.idcypher || '',
                            html: '<!-- Error al renderizar componente -->',
                        });
                    }
                }
            }
        }

        return componentesRenderizados;
    }

    /**
     * Inyecta el HTML del menú en el HTML principal
     * Reemplaza el placeholder del menú con el HTML renderizado
     * @param {string} html - HTML principal
     * @param {string} menuHTML - HTML del menú renderizado
     * @returns {string} HTML con menú inyectado
     */
    injectMenuHTML(html, menuHTML) {
        // Reemplazar el comentario o placeholder del menú dentro del ul
        html = html.replace(
            /<ul class="menu-list"[^>]*>[\s\S]*?<!-- El menú se generará dinámicamente aquí -->[\s\S]*?<\/ul>/g,
            `<ul class="menu-list" id="menu-list">${menuHTML}</ul>`
        );
        
        // También reemplazar si el ul está vacío (sin comentario)
        html = html.replace(
            /<ul class="menu-list"[^>]*>\s*<\/ul>/g,
            `<ul class="menu-list" id="menu-list">${menuHTML}</ul>`
        );

        // Eliminar el script que hace fetch del menú
        html = html.replace(
            /obtenerMenu\(\);/g,
            '// Menú pre-renderizado en build estático'
        );
        
        // Eliminar la función obtenerMenu completa si existe
        html = html.replace(
            /async function obtenerMenu\(\)[\s\S]*?catch[\s\S]*?\}\);/g,
            '// Menú pre-renderizado en build estático'
        );

        return html;
    }

    /**
     * Inyecta el HTML de los componentes en el HTML principal
     * Reemplaza los divs con data-comp por el HTML renderizado
     * @param {string} html - HTML principal
     * @param {Array} componentesRenderizados - Componentes renderizados
     * @returns {string} HTML con componentes inyectados
     */
    injectComponentHTML(html, componentesRenderizados) {
        // Crear un mapa de idcypher a HTML
        const componentesMap = {};
        componentesRenderizados.forEach((comp) => {
            if (comp.idcypher) {
                componentesMap[comp.idcypher] = comp.html;
            }
        });

        console.log(`   [injectComponentHTML] Mapa de componentes: ${Object.keys(componentesMap).length} componentes`);
        
        // Contar cuántos pub_componente hay en el HTML
        const componentMatches = html.match(/<div\s+class="pub_componente"[^>]*data-comp="([^"]+)"[^>]*><\/div>/g);
        console.log(`   [injectComponentHTML] Encontrados ${componentMatches ? componentMatches.length : 0} divs pub_componente en HTML`);

        // Reemplazar los divs .pub_componente con el HTML renderizado
        // Buscamos patrones como: <div class="pub_componente" ... data-comp="TOKEN">
        const componentRegex = /<div\s+class="pub_componente"[^>]*data-comp="([^"]+)"[^>]*><\/div>/g;

        let replacementCount = 0;
        html = html.replace(componentRegex, (match, idcypher) => {
            const componentHTML = componentesMap[idcypher] || 
                                 '<!-- Componente no encontrado -->';
            if (componentesMap[idcypher]) {
                replacementCount++;
            }
            return componentHTML;
        });
        
        console.log(`   [injectComponentHTML] Reemplazados ${replacementCount} componentes`);
        
        // VERIFICAR que los scripts de los componentes estén incluidos
        const scriptsInComponents = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi);
        const scriptCount = scriptsInComponents ? scriptsInComponents.length : 0;
        console.log(`   [injectComponentHTML] Scripts encontrados en HTML después de inyectar componentes: ${scriptCount}`);
        
        if (scriptCount === 0) {
            console.warn(`   ⚠️  ADVERTENCIA: No se encontraron scripts en el HTML después de inyectar componentes!`);
            console.warn(`   - Los componentes pueden tener JavaScript que necesita ejecutarse`);
        }

        // Eliminar el script completo que hace fetch de componentes
        // IMPORTANTE: Buscar el script de forma más segura para NO eliminar contenido fuera
        // El script está dentro de visorpaginas, después del cierre de </div> de contPub
        
        const beforeScriptRemoval = html.length;
        const hasContPubBefore = html.includes('contPub');
        
        // Buscar el script que contiene "componentesParaRenderizar" y "fetch('/public/getComponente"
        // Usar un enfoque más seguro: encontrar el inicio y fin del script de forma precisa
        const scriptStartMarker = '<script>';
        const scriptEndMarker = '</script>';
        const scriptContentMarker = 'componentesParaRenderizar';
        const fetchMarker = "fetch('/public/getComponente";
        
        // Buscar el índice donde comienza el script problemático
        let scriptStartIndex = html.indexOf(scriptStartMarker);
        let attempts = 0;
        const maxAttempts = 10;
        
        while (scriptStartIndex !== -1 && attempts < maxAttempts) {
            // Buscar el siguiente </script> después de este <script>
            const scriptEndIndex = html.indexOf(scriptEndMarker, scriptStartIndex + scriptStartMarker.length);
            
            if (scriptEndIndex !== -1) {
                // Extraer el contenido del script
                const scriptContent = html.substring(scriptStartIndex, scriptEndIndex + scriptEndMarker.length);
                
                // Verificar si este script contiene el código de componentes
                if (scriptContent.includes(scriptContentMarker) && scriptContent.includes(fetchMarker)) {
                    console.log(`   [injectComponentHTML] Encontrado script de componentes en posición ${scriptStartIndex}`);
                    // Reemplazar solo este script específico
                    html = html.substring(0, scriptStartIndex) + 
                           '<!-- Script de componentes eliminado (pre-renderizado en build estático) -->' + 
                           html.substring(scriptEndIndex + scriptEndMarker.length);
                    break; // Salir del loop una vez que encontramos y eliminamos el script
                }
            }
            
            // Buscar el siguiente <script>
            scriptStartIndex = html.indexOf(scriptStartMarker, scriptStartIndex + 1);
            attempts++;
        }
        
        const afterScriptRemoval = html.length;
        const hasContPubAfter = html.includes('contPub');
        
        if (beforeScriptRemoval !== afterScriptRemoval) {
            console.log(`   [injectComponentHTML] Script eliminado, reducción: ${beforeScriptRemoval - afterScriptRemoval} caracteres`);
        }
        
        if (hasContPubBefore && !hasContPubAfter) {
            console.error(`   ❌ ERROR CRÍTICO: Después de eliminar scripts, el HTML perdió contPub!`);
            console.error(`   - Esto NO debería pasar. El script NO debería estar dentro de contPub.`);
        }
        
        // Log para debug
        console.log(`   [injectComponentHTML] HTML después de eliminar scripts, longitud: ${html.length}`);
        console.log(`   [injectComponentHTML] Tiene contPub después de eliminar scripts: ${hasContPubAfter}`);

        return html;
    }

    /**
     * Convierte una imagen a base64
     * @param {string} imagePath - Ruta del archivo de imagen
     * @returns {string|null} Data URL base64 o null si falla
     */
    imageToBase64(imagePath) {
        try {
            if (!fs.existsSync(imagePath)) {
                return null;
            }
            const imageBuffer = fs.readFileSync(imagePath);
            const ext = path.extname(imagePath).toLowerCase();
            let mimeType = 'image/png';
            
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            else if (ext === '.gif') mimeType = 'image/gif';
            else if (ext === '.svg') mimeType = 'image/svg+xml';
            else if (ext === '.webp') mimeType = 'image/webp';
            
            return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
        } catch (error) {
            console.error(`   ❌ Error convirtiendo imagen a base64 ${imagePath}:`, error.message);
            return null;
        }
    }

    /**
     * Inyecta imágenes locales como base64 en el HTML
     * @param {string} html - HTML con referencias a imágenes
     * @returns {string} HTML con imágenes en base64
     */
    injectInlineImages(html) {
        try {
            console.log(`📦 Inyectando imágenes como base64...`);
            
            const publicPath = path.join(__dirname, '../public');
            const imageRegex = /(<img[^>]+src\s*=\s*["'])(\/assets\/[^"']+\.(png|jpg|jpeg|gif|svg|webp))(["'][^>]*>)/gi;
            const images = [];
            let match;
            
            while ((match = imageRegex.exec(html)) !== null) {
                images.push({
                    fullMatch: match[0],
                    beforeSrc: match[1],
                    imagePath: match[2],
                    extension: match[3],
                    afterSrc: match[4]
                });
            }
            
            console.log(`   - Encontradas ${images.length} imágenes locales para convertir`);
            
            let convertedCount = 0;
            images.forEach((img, index) => {
                try {
                    const imageFilePath = path.join(publicPath, img.imagePath.replace(/^\//, ''));
                    const base64 = this.imageToBase64(imageFilePath);
                    
                    if (base64) {
                        // Reemplazar la ruta por base64
                        const newImgTag = `${img.beforeSrc}${base64}${img.afterSrc}`;
                        html = html.replace(img.fullMatch, newImgTag);
                        convertedCount++;
                        console.log(`   ✅ ${index + 1}/${images.length}: ${img.imagePath} → base64 (${base64.length} chars)`);
                    } else {
                        console.warn(`   ⚠️  ${index + 1}/${images.length}: No se pudo convertir ${img.imagePath}`);
                    }
                } catch (error) {
                    console.error(`   ❌ Error procesando ${img.imagePath}:`, error.message);
                }
            });
            
            console.log(`   ✅ ${convertedCount}/${images.length} imágenes convertidas a base64`);
            return html;
        } catch (error) {
            console.error('❌ Error inyectando imágenes inline:', error);
            return html;
        }
    }

    /**
     * Inyecta archivos JavaScript locales como scripts inline
     * @param {string} html - HTML con referencias a JS
     * @returns {string} HTML con JS inyectado
     */
    injectInlineJS(html) {
        try {
            console.log(`📦 Inyectando JavaScript inline...`);
            
            const publicPath = path.join(__dirname, '../public');
            const jsScriptRegex = /<script[^>]+src\s*=\s*["'](\/assets\/js\/[^"']+\.js)["'][^>]*><\/script>/gi;
            const jsScripts = [];
            let match;
            
            while ((match = jsScriptRegex.exec(html)) !== null) {
                jsScripts.push({
                    fullTag: match[0],
                    jsPath: match[1]
                });
            }
            
            console.log(`   - Encontrados ${jsScripts.length} archivos JS locales para inyectar`);
            
            let allInlineJS = '';
            jsScripts.forEach((script, index) => {
                try {
                    const jsFilePath = path.join(publicPath, script.jsPath.replace(/^\//, ''));
                    
                    if (fs.existsSync(jsFilePath)) {
                        const jsContent = fs.readFileSync(jsFilePath, 'utf8');
                        // Minificar JS básico
                        const minifiedJS = jsContent
                            .replace(/\/\*[\s\S]*?\*\//g, '') // Eliminar comentarios multilínea
                            .replace(/\/\/.*$/gm, '') // Eliminar comentarios de línea
                            .replace(/\s+/g, ' ') // Comprimir espacios
                            .replace(/\s*([{}();,=+\-*/%<>!&|])\s*/g, '$1') // Eliminar espacios alrededor de operadores
                            .trim();
                        
                        allInlineJS += `\n/* ${script.jsPath} */\n${minifiedJS}\n`;
                        console.log(`   ✅ ${index + 1}/${jsScripts.length}: ${script.jsPath} (${jsContent.length} → ${minifiedJS.length} chars)`);
                    } else {
                        console.warn(`   ⚠️  ${index + 1}/${jsScripts.length}: No se encontró ${jsFilePath}`);
                    }
                } catch (error) {
                    console.error(`   ❌ Error leyendo ${script.jsPath}:`, error.message);
                }
            });
            
            // Si hay JS para inyectar, agregarlo antes de </body> y eliminar los <script> tags
            if (allInlineJS) {
                const scriptTag = `<script id="inline-js-bundle">${allInlineJS}</script>`;
                
                // Insertar el JS antes del cierre de </body>
                html = html.replace(/<\/body>/i, `${scriptTag}\n</body>`);
                
                // Eliminar los <script> tags de JS locales
                jsScripts.forEach(script => {
                    html = html.replace(script.fullTag, '');
                });
                
                console.log(`   ✅ JavaScript inline inyectado: ${allInlineJS.length} caracteres`);
                console.log(`   ✅ ${jsScripts.length} <script> tags eliminados`);
            } else {
                console.warn(`   ⚠️  No se pudo inyectar ningún JavaScript`);
            }
            
            return html;
        } catch (error) {
            console.error('❌ Error inyectando JavaScript inline:', error);
            return html;
        }
    }

    /**
     * Bundler de JavaScript para componentes de SSG
     * Recibe un JSON con componentes y devuelve un archivo JavaScript final
     * @param {Array|Object} componentsData - JSON con componentes: [{id, type, js}] o {components: [...]}
     * @returns {string} JavaScript bundlado sin imports ni requires
     */
    bundleComponentJS(componentsData) {
        try {
            // Normalizar entrada: puede ser array o objeto con propiedad components
            let components = Array.isArray(componentsData) 
                ? componentsData 
                : (componentsData.components || []);
            
            if (!Array.isArray(components) || components.length === 0) {
                return '';
            }
            
            let bundledJS = '';
            
            // Envolver todo en DOMContentLoaded para asegurar que el DOM existe
            bundledJS += '(function() {\n';
            bundledJS += '    "use strict";\n';
            bundledJS += '    \n';
            bundledJS += '    function initComponents() {\n';
            
            // Procesar cada componente
            components.forEach((component, index) => {
                const id = component.id || component.cmp_id || '';
                const type = component.type || component.cmp_type || 'unknown';
                const js = component.js || component.js_code || '';
                
                if (!id || !js) {
                    return;
                }
                
                // Envolver cada componente en un IIFE
                bundledJS += `        \n`;
                bundledJS += `        // Componente ${index + 1}: ${type} (id: ${id})\n`;
                bundledJS += `        (function() {\n`;
                bundledJS += `            "use strict";\n`;
                bundledJS += `            try {\n`;
                bundledJS += `                const root = document.querySelector('[data-cmp-id="${id}"]');\n`;
                bundledJS += `                if (!root) {\n`;
                bundledJS += `                    return;\n`;
                bundledJS += `                }\n`;
                bundledJS += `                \n`;
                bundledJS += `                // Props del componente (pueden venir de data attributes)\n`;
                bundledJS += `                const props = {\n`;
                bundledJS += `                    id: "${id}",\n`;
                bundledJS += `                    type: "${type}",\n`;
                bundledJS += `                    root: root\n`;
                bundledJS += `                };\n`;
                bundledJS += `                \n`;
                bundledJS += `                // Ejecutar código del componente como función\n`;
                bundledJS += `                (function(root, props) {\n`;
                bundledJS += `                    "use strict";\n`;
                bundledJS += `                    \n`;
                
                // Insertar el código del componente (ya debe estar como función o código ejecutable)
                // Si el código no es una función, lo envolvemos en una función anónima
                const componentCode = js.trim();
                const isFunction = componentCode.startsWith('function') || 
                                  componentCode.startsWith('(') || 
                                  componentCode.startsWith('=>');
                
                if (isFunction) {
                    // Si ya es una función, ejecutarla directamente
                    bundledJS += `                    ${componentCode}\n`;
                } else {
                    // Si es código suelto, envolverlo en una función anónima
                    bundledJS += `                    (function() {\n`;
                    bundledJS += `                        ${componentCode}\n`;
                    bundledJS += `                    })();\n`;
                }
                
                bundledJS += `                })(root, props);\n`;
                bundledJS += `            } catch (error) {\n`;
                bundledJS += `                console.error('[Component Error] id: "${id}", type: "${type}", error:', error);\n`;
                bundledJS += `            }\n`;
                bundledJS += `        })();\n`;
            });
            
            bundledJS += '    }\n';
            bundledJS += '    \n';
            bundledJS += '    // Ejecutar cuando el DOM esté listo\n';
            bundledJS += '    if (document.readyState === "loading") {\n';
            bundledJS += '        document.addEventListener("DOMContentLoaded", initComponents);\n';
            bundledJS += '    } else {\n';
            bundledJS += '        initComponents();\n';
            bundledJS += '    }\n';
            bundledJS += '})();\n';
            
            return bundledJS;
        } catch (error) {
            console.error('❌ Error en bundleComponentJS:', error);
            return '';
        }
    }

    /**
     * Inyecta los archivos CSS locales como estilos inline en el HTML
     * Esto permite que el HTML funcione sin servidor web
     * @param {string} html - HTML con referencias a CSS
     * @returns {string} HTML con CSS inyectado
     */
    injectInlineCSS(html) {
        try {
            console.log(`📦 Inyectando CSS inline en el HTML...`);
            
            // Buscar todos los <link> tags que apuntan a CSS locales
            const cssLinkRegex = /<link[^>]+href\s*=\s*["'](\/assets\/css\/[^"']+\.css)["'][^>]*>/gi;
            const cssLinks = [];
            let match;
            
            while ((match = cssLinkRegex.exec(html)) !== null) {
                cssLinks.push({
                    fullTag: match[0],
                    cssPath: match[1]
                });
            }
            
            console.log(`   - Encontrados ${cssLinks.length} archivos CSS locales para inyectar`);
            
            // Leer e inyectar cada archivo CSS
            let allInlineCSS = '';
            // La ruta desde buildService.js (src/services/) a public es: ../../public
            // Pero los archivos están en src/public, así que la ruta correcta es: ../public
            const publicPath = path.join(__dirname, '../public');
            
            cssLinks.forEach((link, index) => {
                try {
                    // Convertir ruta /assets/css/estilos.css a ruta del sistema de archivos
                    // link.cssPath = "/assets/css/estilos.css"
                    // Necesitamos: src/public/assets/css/estilos.css
                    const cssFilePath = path.join(publicPath, link.cssPath.replace(/^\//, ''));
                    
                    if (fs.existsSync(cssFilePath)) {
                        let cssContent = fs.readFileSync(cssFilePath, 'utf8');
                        
                        // Convertir referencias a imágenes en CSS a base64
                        // Maneja tanto rutas relativas (../img/...) como absolutas (/assets/img/...)
                        const cssImageRegex = /url\(["']?([^"')]+\.(png|jpg|jpeg|gif|svg|webp))["']?\)/gi;
                        let cssImageMatch;
                        let imageReplacements = 0;
                        const processedUrls = new Map();
                        
                        // Primero recopilar todas las coincidencias
                        const matches = [];
                        while ((cssImageMatch = cssImageRegex.exec(cssContent)) !== null) {
                            matches.push({
                                fullMatch: cssImageMatch[0],
                                imagePath: cssImageMatch[1].trim(),
                                extension: cssImageMatch[2]
                            });
                        }
                        
                        // Procesar cada coincidencia
                        matches.forEach((matchData) => {
                            let imageFilePath = null;
                            const originalPath = matchData.imagePath;
                            
                            // Ignorar URLs externas (http/https) y data URIs ya convertidas
                            if (originalPath.startsWith('http://') || 
                                originalPath.startsWith('https://') || 
                                originalPath.startsWith('data:')) {
                                return;
                            }
                            
                            // Si ya procesamos esta URL, usar el resultado anterior
                            if (processedUrls.has(originalPath)) {
                                const base64 = processedUrls.get(originalPath);
                                if (base64) {
                                    cssContent = cssContent.replace(matchData.fullMatch, `url(${base64})`);
                                    imageReplacements++;
                                }
                                return;
                            }
                            
                            // Caso 1: Ruta absoluta que empieza con /assets/
                            if (originalPath.startsWith('/assets/')) {
                                imageFilePath = path.join(publicPath, originalPath.replace(/^\//, ''));
                            }
                            // Caso 2: Ruta relativa que empieza con ../
                            else if (originalPath.startsWith('../')) {
                                // Resolver ruta relativa desde la ubicación del archivo CSS
                                const cssDir = path.dirname(cssFilePath);
                                imageFilePath = path.resolve(cssDir, originalPath);
                            }
                            // Caso 3: Ruta relativa sin ../
                            else if (!originalPath.startsWith('/')) {
                                const cssDir = path.dirname(cssFilePath);
                                imageFilePath = path.resolve(cssDir, originalPath);
                            }
                            
                            // Intentar convertir a base64
                            let base64 = null;
                            if (imageFilePath && fs.existsSync(imageFilePath)) {
                                base64 = this.imageToBase64(imageFilePath);
                                if (base64) {
                                    cssContent = cssContent.replace(matchData.fullMatch, `url(${base64})`);
                                    imageReplacements++;
                                    const relativePath = path.relative(publicPath, imageFilePath);
                                    console.log(`   📷 Imagen CSS convertida: ${relativePath} (${(fs.statSync(imageFilePath).size / 1024).toFixed(2)} KB)`);
                                }
                            } else if (imageFilePath) {
                                console.warn(`   ⚠️ Imagen CSS no encontrada: ${path.relative(publicPath, imageFilePath)}`);
                            }
                            
                            // Guardar resultado (incluso si es null) para evitar procesar de nuevo
                            processedUrls.set(originalPath, base64);
                        });
                        
                        if (imageReplacements > 0) {
                            console.log(`   ✅ ${imageReplacements} imagen(es) en CSS convertida(s) a base64`);
                        }
                        
                        // Minificar el CSS también
                        const minifiedCSS = cssContent
                            .replace(/\/\*[\s\S]*?\*\//g, '') // Eliminar comentarios
                            .replace(/\s+/g, ' ') // Comprimir espacios
                            .replace(/\s*([{}:;,])\s*/g, '$1') // Eliminar espacios alrededor de caracteres especiales
                            .trim();
                        
                        allInlineCSS += `\n/* ${link.cssPath} */\n${minifiedCSS}\n`;
                        console.log(`   ✅ ${index + 1}/${cssLinks.length}: ${link.cssPath} (${cssContent.length} → ${minifiedCSS.length} chars)`);
                    } else {
                        console.warn(`   ⚠️  ${index + 1}/${cssLinks.length}: No se encontró ${cssFilePath}`);
                    }
                } catch (error) {
                    console.error(`   ❌ Error leyendo ${link.cssPath}:`, error.message);
                }
            });
            
            // Si hay CSS para inyectar, agregarlo al <head> y eliminar los <link> tags
            if (allInlineCSS) {
                // Crear el tag <style> con todo el CSS
                const styleTag = `<style id="inline-css-bundle">${allInlineCSS}</style>`;
                
                // Insertar el CSS antes del cierre de </head>
                html = html.replace(/<\/head>/i, `${styleTag}\n</head>`);
                
                // Eliminar los <link> tags de CSS locales
                cssLinks.forEach(link => {
                    html = html.replace(link.fullTag, '');
                });
                
                console.log(`   ✅ CSS inline inyectado: ${allInlineCSS.length} caracteres`);
                console.log(`   ✅ ${cssLinks.length} <link> tags eliminados`);
            } else {
                console.warn(`   ⚠️  No se pudo inyectar ningún CSS`);
            }
            
            return html;
        } catch (error) {
            console.error('❌ Error inyectando CSS inline:', error);
            // Si falla, devolver el HTML original
            return html;
        }
    }

    /**
     * Minifica y ofusca el HTML para dificultar la lectura
     * @param {string} html - HTML a minificar
     * @returns {string} HTML minificado y ofuscado
     */
    minifyAndObfuscateHTML(html) {
        let minified = html;
        
        // 1. Eliminar comentarios HTML (excepto los que necesitamos mantener)
        minified = minified.replace(/<!--(?!<!)[^\[>].*?-->/g, '');
        
        // 2. Eliminar espacios en blanco múltiples
        minified = minified.replace(/\s+/g, ' ');
        
        // 3. Eliminar espacios antes y después de tags (pero mantener dentro de atributos)
        minified = minified.replace(/>\s+</g, '><');
        
        // 4. Eliminar espacios al inicio y final de líneas (ya no hay líneas, pero por si acaso)
        minified = minified.trim();
        
        // 5. Comprimir espacios dentro de atributos (mantener al menos uno)
        minified = minified.replace(/\s*=\s*"/g, '="');
        minified = minified.replace(/\s*=\s*'/g, "='");
        minified = minified.replace(/\s+/g, ' ');
        
        // 6. Eliminar saltos de línea y tabs
        minified = minified.replace(/\n/g, '');
        minified = minified.replace(/\r/g, '');
        minified = minified.replace(/\t/g, '');
        
        // 7. Comprimir espacios múltiples a uno solo (SOLO FUERA de scripts)
        // Primero extraer scripts para protegerlos
        const scriptPlaceholders = [];
        let scriptIndex = 0;
        minified = minified.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attributes, scriptContent) => {
            const placeholder = `__SCRIPT_PLACEHOLDER_${scriptIndex}__`;
            scriptPlaceholders[scriptIndex] = { match, attributes, scriptContent };
            scriptIndex++;
            return placeholder;
        });
        
        // Ahora comprimir espacios en el HTML (sin scripts)
        minified = minified.replace(/\s{2,}/g, ' ');
        
        // 8. NO eliminar espacios alrededor de operadores - esto rompe el JavaScript
        // minified = minified.replace(/\s*([=+\-*/%<>!&|])\s*/g, '$1'); // ELIMINADO - rompe código JS
        
        // 9. Comprimir espacios en atributos de estilo
        minified = minified.replace(/style\s*=\s*"([^"]*)"/g, (match, styleContent) => {
            const compressed = styleContent.replace(/\s+/g, ' ').trim();
            return `style="${compressed}"`;
        });
        
        // 10. Eliminar espacios innecesarios en clases
        minified = minified.replace(/class\s*=\s*"([^"]*)"/g, (match, classContent) => {
            const compressed = classContent.replace(/\s+/g, ' ').trim();
            return `class="${compressed}"`;
        });
        
        // 11. RESTAURAR scripts inline SIN ofuscar (preservar funcionalidad)
        // IMPORTANTE: Los scripts de los componentes DEBEN preservarse EXACTAMENTE como están
        scriptPlaceholders.forEach((placeholder, index) => {
            const { attributes, scriptContent } = placeholder;
            // Solo comprimir espacios múltiples y líneas vacías, PERO NO cambiar nombres de funciones
            let compressed = scriptContent
                .replace(/\s{3,}/g, ' ')  // Solo espacios múltiples (3+)
                .replace(/\n\s*\n+/g, '\n')  // Eliminar líneas vacías múltiples
                .trim();
            
            // NO hacer ninguna otra transformación que pueda romper el código
            const restoredScript = `<script${attributes}>${compressed}</script>`;
            minified = minified.replace(`__SCRIPT_PLACEHOLDER_${index}__`, restoredScript);
        });
        
        // 12. Eliminar espacios finales e iniciales en el HTML completo
        minified = minified.trim();
        
        return minified;
    }

    /**
     * Obtiene todas las páginas publicadas de una aplicación
     * @param {number} idApp - ID de la aplicación
     * @returns {Promise<Array>} Array de páginas publicadas con datos completos
     */
    async getAllPublishedPages(idApp) {
        try {
            // Obtener todas las páginas publicadas usando findAll directo
            const allPagesRaw = await pagina.findAll({
                where: {
                    fk_id_sysapp: idApp,
                    vigente: true,
                    publicada: true
                },
                attributes: ['id_wb_pagina', 'nombre_pagina', 'url_safe', 'fk_id_cat_type_pagina']
            });
            
            // Para cada página, obtener sus datos completos usando getDataPaginaID
            const allPages = [];
            for (const pageRaw of allPagesRaw) {
                try {
                    const pageData = await pagina.getDataPaginaID(pageRaw.id_wb_pagina);
                    if (pageData && pageData.length > 0) {
                        allPages.push(pageData[0]);
                    }
                } catch (error) {
                    console.error(`Error obteniendo datos de página ${pageRaw.id_wb_pagina}:`, error.message);
                }
            }
            
            return allPages;
        } catch (error) {
            console.error('Error obteniendo páginas publicadas:', error);
            return [];
        }
    }

    /**
     * Genera un HTML con TODAS las páginas publicadas embebidas (SPA)
     * @param {Object} objapp - Objeto de la aplicación
     * @returns {Promise<string>} Ruta del archivo generado
     */
    async buildAllPagesSPA(objapp) {
        try {
            console.log(`🚀 [buildAllPagesSPA] Generando HTML con todas las páginas para app: ${objapp.id_sysapp}`);
            
            // Obtener todas las páginas publicadas
            const allPages = await this.getAllPublishedPages(objapp.id_sysapp);
            console.log(`   - Encontradas ${allPages.length} páginas publicadas`);
            
            if (allPages.length === 0) {
                throw new Error('No hay páginas publicadas para generar el SPA');
            }
            
            // Generar HTML para cada página
            const pagesHTML = [];
            const pagesMap = {}; // Mapa de URL -> HTML
            
            for (const page of allPages) {
                try {
                    const urlSafe = page.url_safe || '/';
                    const typeUri = page.fk_id_cat_type_pagina;
                    
                    // Firmar componentes
                    const jwt = require('jsonwebtoken');
                    for (const seccion of page.secciones || []) {
                        for (const columna of seccion.columnas || []) {
                            for (const componente of columna.componentes || []) {
                                const idcypher = jwt.sign(
                                    {
                                        id_componente: componente.dataValues.id_wb_pag_componente,
                                        tabla: componente.tipoComponente.dataValues.table_componente,
                                        date_comp: new Date()
                                    },
                                    objapp.key_sysapp
                                );
                                componente.idcypher = idcypher;
                            }
                        }
                    }
                    
                    // Generar HTML para esta página
                    const pageHTML = await this.generateStaticHTML(
                        objapp,
                        page,
                        urlSafe,
                        typeUri
                    );
                    
                    // Extraer solo el contenido del body (sin head, sin body tags)
                    const bodyMatch = pageHTML.match(/<body[^>]*>([\s\S]*)<\/body>/i);
                    const bodyContent = bodyMatch ? bodyMatch[1] : pageHTML;
                    
                    // Crear una clave única para esta página
                    const pageKey = typeUri === 1 ? 'home' : urlSafe.replace(/[^a-zA-Z0-9]/g, '_');
                    pagesMap[pageKey] = {
                        url: urlSafe,
                        typeUri: typeUri,
                        html: bodyContent,
                        title: page.nombre_pagina || 'Página'
                    };
                    
                    pagesHTML.push({
                        key: pageKey,
                        url: urlSafe,
                        typeUri: typeUri,
                        title: page.nombre_pagina || 'Página'
                    });
                    
                    console.log(`   ✅ Página generada: ${pageKey} (${urlSafe})`);
                } catch (error) {
                    console.error(`   ❌ Error generando página ${page.url_safe}:`, error.message);
                }
            }
            
            // Obtener el HTML de la primera página (home) como base
            const homePage = allPages.find(p => p.fk_id_cat_type_pagina === 1) || allPages[0];
            const baseHTML = await this.generateStaticHTML(
                objapp,
                homePage,
                homePage.url_safe || '/',
                homePage.fk_id_cat_type_pagina
            );
            
            // Extraer el head del HTML base
            const headMatch = baseHTML.match(/<head[^>]*>([\s\S]*)<\/head>/i);
            const headContent = headMatch ? headMatch[1] : '';
            
            // Crear el HTML SPA con todas las páginas embebidas
            const spaHTML = `<!doctype html>
<html lang="en" data-bs-theme="auto">
<head>
${headContent}
<style>
/* Estilos para el sistema de navegación SPA */
.spa-page {
    display: none;
}
.spa-page.active {
    display: block;
}
</style>
</head>
<body>
<!-- Contenedor principal SPA -->
<div id="spa-container">
${Object.entries(pagesMap).map(([key, page]) => 
    `<div class="spa-page" id="page-${key}" data-url="${page.url}" data-type="${page.typeUri}">
        ${page.html}
    </div>`
).join('\n')}
</div>

<!-- Sistema de navegación SPA -->
<script>
(function() {
    const pagesMap = ${JSON.stringify(Object.keys(pagesMap).reduce((acc, key) => {
        acc[key] = { url: pagesMap[key].url, typeUri: pagesMap[key].typeUri, title: pagesMap[key].title };
        return acc;
    }, {}), null, 2)};
    const pagesList = ${JSON.stringify(pagesHTML, null, 2)};
    
    // Función para mostrar una página
    function showPage(pageKey) {
        // Ocultar todas las páginas
        document.querySelectorAll('.spa-page').forEach(page => {
            page.classList.remove('active');
        });
        
        // Mostrar la página solicitada
        const targetPage = document.getElementById('page-' + pageKey);
        if (targetPage) {
            targetPage.classList.add('active');
            // Scroll al inicio
            window.scrollTo(0, 0);
            // Actualizar URL sin recargar
            const pageData = pagesMap[pageKey];
            if (pageData) {
                window.history.pushState({page: pageKey}, pageData.title, pageData.url || '/');
                document.title = pageData.title;
            }
        }
    }
    
    // Función para encontrar página por URL
    function findPageByUrl(url) {
        if (!url) return null;
        
        // Normalizar URL - remover dominio si existe
        let normalizedUrl = url.replace(/^https?:\/\/[^\/]+/, '').replace(/^\\//, '').replace(/\\/$/, '');
        if (normalizedUrl === '') normalizedUrl = '/';
        
        // Buscar coincidencia exacta
        let found = pagesList.find(p => {
            const pageUrl = (p.url || '/').replace(/^\\//, '').replace(/\\/$/, '');
            const normalizedPageUrl = pageUrl === '' ? '/' : pageUrl;
            return normalizedPageUrl === normalizedUrl || 
                   (p.typeUri === 1 && (normalizedUrl === '/' || normalizedUrl === ''));
        });
        
        // Si no se encuentra, buscar por coincidencia parcial (solo el último segmento)
        if (!found && normalizedUrl !== '/') {
            const urlSegments = normalizedUrl.split('/');
            const lastSegment = urlSegments[urlSegments.length - 1];
            found = pagesList.find(p => {
                const pageUrl = (p.url || '').replace(/^\\//, '').replace(/\\/$/, '');
                return pageUrl === lastSegment || pageUrl.endsWith('/' + lastSegment);
            });
        }
        
        return found;
    }
    
    /** Enlaces que no deben enrutarse por el SPA (absolutos, protocolo-rel., mail/tel/ftp, o www. sin esquema). */
    function isExternalOrSpecialHref(href) {
        if (href == null) return false;
        var h = String(href).trim();
        if (h === '' || h === '#') return false;
        if (h.indexOf('#') === 0) return false;
        if (/^https?:\\/\\//i.test(h)) return true;
        if (h.indexOf('//') === 0) return true;
        if (/^mailto:/i.test(h)) return true;
        if (/^tel:/i.test(h)) return true;
        if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return true;
        if (/^www\\./i.test(h)) return true;
        return false;
    }
    
    // Interceptar clicks en enlaces
    document.addEventListener('DOMContentLoaded', function() {
        // Interceptar TODOS los clicks en enlaces después de que se carguen
        setTimeout(function() {
            document.addEventListener('click', function(e) {
                const link = e.target.closest('a');
                if (link) {
                    const href = link.getAttribute('href');
                    if (href && !isExternalOrSpecialHref(href)) {
                        // Si es un hash/ancla, permitir comportamiento normal
                        if (href.trim().startsWith('#')) {
                            return;
                        }
                        
                        e.preventDefault();
                        e.stopPropagation();
                        
                        const foundPage = findPageByUrl(href);
                        if (foundPage) {
                            showPage(foundPage.key);
                        } else {
                            console.warn('Página no encontrada para URL:', href, 'Páginas disponibles:', pagesList.map(p => p.url));
                        }
                    }
                }
            }, true);
        }, 100);
        
        // Mostrar la página inicial (home)
        const homePage = pagesList.find(p => p.typeUri === 1) || pagesList[0];
        if (homePage) {
            showPage(homePage.key);
        }
        
        // Manejar navegación del navegador (back/forward)
        window.addEventListener('popstate', function(e) {
            if (e.state && e.state.page) {
                showPage(e.state.page);
            } else {
                // Si no hay state, mostrar home
                const homePage = pagesList.find(p => p.typeUri === 1) || pagesList[0];
                if (homePage) {
                    showPage(homePage.key);
                }
            }
        });
    });
})();
</script>
</body>
</html>`;
            
            // Inyectar recursos inline
            let finalHTML = spaHTML;
            finalHTML = this.injectInlineCSS(finalHTML);
            finalHTML = this.injectInlineImages(finalHTML);
            finalHTML = this.injectInlineJS(finalHTML);
            
            // Minificar
            finalHTML = this.minifyAndObfuscateHTML(finalHTML);
            
            // Guardar el archivo
            const appUrl = objapp.urluri.replace(/^https?:\/\//, '').replace(/\/$/, '');
            const hash = this.generateHash(`spa-${appUrl}`);
            const fileName = `spa-${hash}.html`;
            const filePath = path.join(this.distPath, `app_${objapp.id_sysapp}`, fileName);
            
            // Asegurar que el directorio existe
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(filePath, finalHTML, 'utf8');
            
            console.log(`✅ SPA generado con ${allPages.length} páginas: ${filePath}`);
            return filePath;
        } catch (error) {
            console.error('❌ Error generando SPA:', error);
            throw error;
        }
    }

    /**
     * Construye y guarda el archivo estático de una página
     * @param {string} fullUrl - URL completa (host + path) para generar el hash
     * @param {Object} objapp - Objeto de la aplicación
     * @param {Object} objpagina - Objeto de la página
     * @param {string} paginaUri - URI de la página
     * @param {number} typeUri - Tipo de URI
     * @returns {Promise<string>} Ruta del archivo generado
     */
    async buildPage(fullUrl, objapp, objpagina, paginaUri, typeUri) {
        try {
            console.log(`🚀 [buildPage] Iniciando build para: ${fullUrl}`);
            console.log(`   - idApp: ${objapp.id_sysapp}`);
            console.log(`   - paginaUri: ${paginaUri}`);
            console.log(`   - typeUri: ${typeUri}`);
            console.log(`   - objpagina tiene secciones: ${objpagina && objpagina.secciones ? 'SÍ' : 'NO'}`);
            
            let html = await this.generateStaticHTML(
                objapp,
                objpagina,
                paginaUri,
                typeUri
            );

            // VERIFICACIÓN FINAL: Asegurar que el HTML tenga el contenido
            if (!html.includes('contPub')) {
                console.error(`❌ ERROR CRÍTICO: El HTML generado NO tiene contPub!`);
                console.error(`   - No se puede guardar un HTML sin contenido`);
                console.error(`   - Longitud HTML: ${html.length}`);
                throw new Error('El HTML generado no contiene contPub - no se puede guardar');
            }
            
            if (!html.includes('pub_componente') && !html.includes('pub_seccion')) {
                console.warn(`⚠️  ADVERTENCIA: El HTML NO tiene pub_componente ni pub_seccion`);
                console.warn(`   - Esto puede significar que no hay componentes en la página`);
            }

            // Inyectar todos los recursos inline ANTES de minificar (para que funcione sin servidor)
            console.log(`📦 Inyectando recursos inline para HTML standalone...`);
            
            // 1. Inyectar CSS inline
            html = this.injectInlineCSS(html);
            
            // 2. Inyectar imágenes como base64
            html = this.injectInlineImages(html);
            
            // 3. Inyectar JavaScript inline
            html = this.injectInlineJS(html);
            
            // 4. VERIFICAR que los scripts de los componentes estén preservados
            const scriptsBeforeMinify = (html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []).length;
            console.log(`📦 Scripts encontrados antes de minificar: ${scriptsBeforeMinify}`);
            
            if (scriptsBeforeMinify === 0) {
                console.error(`❌ ERROR: No se encontraron scripts en el HTML antes de minificar!`);
                console.error(`   - Los componentes pueden tener JavaScript que necesita ejecutarse`);
            }
            
            console.log(`✅ Todos los recursos inline inyectados - HTML completamente standalone`);

            // Minificar y ofuscar el HTML antes de guardarlo
            const htmlLengthBefore = html.length;
            
            html = this.minifyAndObfuscateHTML(html);
            
            const htmlLengthAfter = html.length;
            const compressionRatio = ((htmlLengthBefore - htmlLengthAfter) / htmlLengthBefore * 100).toFixed(2);
            const scriptsAfterMinify = (html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []).length;
            
            console.log(`📦 HTML minificado: ${htmlLengthBefore} → ${htmlLengthAfter} caracteres (${compressionRatio}% reducción)`);
            console.log(`📦 Scripts preservados: ${scriptsBeforeMinify} → ${scriptsAfterMinify} scripts`);
            
            if (scriptsBeforeMinify > 0 && scriptsAfterMinify === 0) {
                console.error(`❌ ERROR CRÍTICO: Los scripts se perdieron durante la minificación!`);
                console.error(`   - Scripts antes: ${scriptsBeforeMinify}, Scripts después: ${scriptsAfterMinify}`);
            } else if (scriptsAfterMinify > 0) {
                console.log(`✅ Scripts de componentes preservados correctamente`);
            }

            // Usar idApp y paginaUri para organizar en carpetas
            const filePath = this.getStaticFilePath(fullUrl, objapp.id_sysapp, paginaUri);
            fs.writeFileSync(filePath, html, 'utf8');

            const envType = this.isProduccion ? 'PRODUCCIÓN' : 'DESARROLLO';
            console.log(`✅ Build generado [${envType}]: ${filePath}`);
            console.log(`   - HTML tiene contPub: ${html.includes('contPub')}`);
            console.log(`   - HTML tiene pub_seccion: ${html.includes('pub_seccion')}`);
            console.log(`   - HTML tiene pub_componente: ${html.includes('pub_componente')}`);
            console.log(`   - HTML minificado y ofuscado para dificultar lectura`);
            return filePath;
        } catch (error) {
            console.error('❌ Error en buildPage:', error);
            console.error(`   - Stack: ${error.stack}`);
            throw error;
        }
    }

    /**
     * Elimina el archivo estático de una página
     * @param {string} fullUrl - URL completa (host + path)
     * @param {number} idApp - ID de la aplicación (opcional)
     * @param {string} urlSafe - URL safe de la página (opcional)
     */
    deleteStaticFile(fullUrl, idApp = null, urlSafe = null) {
        try {
            const filePath = this.findStaticFile(fullUrl, idApp, urlSafe);
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🗑️  Archivo estático eliminado: ${filePath}`);
            }
        } catch (error) {
            console.error('Error eliminando archivo estático:', error);
        }
    }

    /**
     * Busca un archivo estático en todas las posibles ubicaciones
     * @param {string} fullUrl - URL completa (host + path)
     * @param {number} idApp - ID de la aplicación (opcional)
     * @param {string} urlSafe - URL safe de la página (opcional)
     * @returns {string|null} Ruta del archivo si existe, null si no
     */
    findStaticFile(fullUrl, idApp = null, urlSafe = null) {
        const hash = this.generateHash(fullUrl);
        const fileName = `${hash}.html`;
        
        console.log(`   [findStaticFile] Hash: ${hash.substring(0, 8)}..., idApp: ${idApp}, urlSafe: ${urlSafe}`);
        
        // Si tenemos idApp y urlSafe, buscar en la estructura organizada
        if (idApp && urlSafe !== null && urlSafe !== undefined) {
            // Normalizar urlSafe: '/' -> 'index', otros valores se limpian
            const safeFolderName = (urlSafe === '/' || urlSafe === '') ? 'index' : urlSafe.replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
            const appFolder = path.join(this.distPath, `app_${idApp}`);
            const routeFolder = path.join(appFolder, safeFolderName);
            const filePath = path.join(routeFolder, fileName);
            
            console.log(`   [findStaticFile] Buscando en: ${filePath}`);
            if (fs.existsSync(filePath)) {
                console.log(`   [findStaticFile] ✅ Archivo encontrado!`);
                return filePath;
            } else {
                console.log(`   [findStaticFile] ❌ Archivo no existe en ruta específica`);
            }
        }
        
        // Buscar en todas las carpetas de apps (búsqueda exhaustiva)
        if (fs.existsSync(this.distPath)) {
            const appFolders = fs.readdirSync(this.distPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('app_'));
            
            console.log(`   [findStaticFile] Buscando en ${appFolders.length} carpetas de apps...`);
            
            for (const appFolder of appFolders) {
                const appPath = path.join(this.distPath, appFolder.name);
                const routeFolders = fs.readdirSync(appPath, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory());
                
                for (const routeFolder of routeFolders) {
                    const routePath = path.join(appPath, routeFolder.name);
                    const filePath = path.join(routePath, fileName);
                    
                    if (fs.existsSync(filePath)) {
                        console.log(`   [findStaticFile] ✅ Archivo encontrado en búsqueda exhaustiva: ${filePath}`);
                        return filePath;
                    }
                }
            }
            
            // También buscar en la raíz (archivos antiguos)
            const rootPath = path.join(this.distPath, fileName);
            if (fs.existsSync(rootPath)) {
                console.log(`   [findStaticFile] ✅ Archivo encontrado en raíz: ${rootPath}`);
                return rootPath;
            }
        }
        
        console.log(`   [findStaticFile] ❌ Archivo no encontrado en ninguna ubicación`);
        return null;
    }

    /**
     * Verifica si existe un archivo estático para una página
     * @param {string} fullUrl - URL completa (host + path)
     * @param {number} idApp - ID de la aplicación (opcional)
     * @param {string} urlSafe - URL safe de la página (opcional)
     * @returns {boolean} True si existe el archivo
     */
    staticFileExists(fullUrl, idApp = null, urlSafe = null) {
        return this.findStaticFile(fullUrl, idApp, urlSafe) !== null;
    }

    /**
     * Lee el contenido de un archivo estático
     * @param {string} fullUrl - URL completa (host + path)
     * @param {number} idApp - ID de la aplicación (opcional)
     * @param {string} urlSafe - URL safe de la página (opcional)
     * @returns {string|null} Contenido del archivo o null si no existe
     */
    readStaticFile(fullUrl, idApp = null, urlSafe = null) {
        try {
            const filePath = this.findStaticFile(fullUrl, idApp, urlSafe);
            if (filePath && fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf8');
            }
            return null;
        } catch (error) {
            console.error('Error leyendo archivo estático:', error);
            return null;
        }
    }
}

module.exports = new BuildService();
