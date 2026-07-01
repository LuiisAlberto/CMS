const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ejs = require('ejs');
const minify = require('html-minifier').minify;
const {pagina} = require('../models/paginasModel');
const publicController = require('../controllers/publicController');
const menuModel = require('../models/menuModel');
const { Op } = require('sequelize');
const { Storage } = require('@google-cloud/storage');
const filesModel = require('../models/files');
const storage_files = require('../models/storage_files');

const storage = new Storage({
    projectId: process.env.PUBLIC_BUCKET_NAME,
    keyFilename: `certs/${process.env.PUBLIC_BUCKET_KEY}`
});

const bucket = storage.bucket(process.env.PUBLIC_BUCKET_NAME);

/**
 * Convierte una imagen a base64 desde Google Cloud Storage o URL
 * @param {string} imageUrl - URL de la imagen o ruta en GCS
 * @returns {Promise<string>} - Base64 de la imagen o URL original si falla
 */
async function imageToBase64(imageUrl) {
    try {
        if (!imageUrl || imageUrl.startsWith('data:')) {
            return imageUrl;
        }

        // Si es una URL externa de CDN (morena.app), intentar descargarla
        if (imageUrl.startsWith('https://cdn.morena.app/')) {
            try {
                const filePath = imageUrl.replace('https://cdn.morena.app/', '');
                const file = bucket.file(filePath);
                const [exists] = await file.exists();
                
                if (exists) {
                    const [buffer] = await file.download();
                    const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
                    const mimeTypeMap = {
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'png': 'image/png',
                        'gif': 'image/gif',
                        'webp': 'image/webp',
                        'svg': 'image/svg+xml'
                    };
                    const mimeType = mimeTypeMap[ext] || 'image/png';
                    const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
                    console.log(`  ✅ Imagen de GCS convertida: ${filePath.substring(0, 50)}... (${(buffer.length / 1024).toFixed(2)} KB)`);
                    return base64;
                } else {
                    console.warn(`  ⚠️ Archivo no existe en GCS: ${filePath}`);
                }
            } catch (gcsError) {
                console.warn(`  ⚠️ No se pudo descargar imagen de GCS: ${imageUrl.substring(0, 80)}...`, gcsError.message);
            }
        }
        
        // Si la URL parece ser una concatenación de storage_path + file_path (sin https://cdn.morena.app/)
        // Intentar construir la URL completa de cdn.morena.app
        if (!imageUrl.startsWith('http') && !imageUrl.startsWith('/') && imageUrl.includes('/')) {
            // Puede ser una ruta relativa que debería estar en cdn.morena.app
            const possibleGcsUrl = `https://cdn.morena.app/${imageUrl}`;
            try {
                const file = bucket.file(imageUrl);
                const [exists] = await file.exists();
                
                if (exists) {
                    const [buffer] = await file.download();
                    const ext = path.extname(imageUrl).slice(1).toLowerCase() || 'png';
                    const mimeTypeMap = {
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'png': 'image/png',
                        'gif': 'image/gif',
                        'webp': 'image/webp',
                        'svg': 'image/svg+xml'
                    };
                    const mimeType = mimeTypeMap[ext] || 'image/png';
                    const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
                    console.log(`  ✅ Imagen de GCS (ruta relativa) convertida: ${imageUrl.substring(0, 50)}... (${(buffer.length / 1024).toFixed(2)} KB)`);
                    return base64;
                }
            } catch (gcsError) {
                // Silenciosamente continuar con otros métodos
            }
        }

        // Si es una URL externa (otro CDN), mantenerla como está
        if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
            return imageUrl;
        }

        // Si es una ruta local relativa, intentar leerla
        const pathsToTry = [
            path.join(__dirname, '../../public', imageUrl),
            path.join(__dirname, '../../../public', imageUrl),
            path.join(process.cwd(), 'app/src/public', imageUrl),
            path.join(process.cwd(), 'public', imageUrl)
        ];

        for (const filePath of pathsToTry) {
            if (fs.existsSync(filePath)) {
                const imageBuffer = fs.readFileSync(filePath);
                const ext = path.extname(imageUrl).slice(1).toLowerCase() || 'png';
                const mimeTypeMap = {
                    'jpg': 'image/jpeg',
                    'jpeg': 'image/jpeg',
                    'png': 'image/png',
                    'gif': 'image/gif',
                    'webp': 'image/webp',
                    'svg': 'image/svg+xml'
                };
                const mimeType = mimeTypeMap[ext] || 'image/png';
                return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
            }
        }

        return imageUrl;
    } catch (error) {
        console.error('Error converting image to base64:', error);
        return imageUrl;
    }
}

/**
 * Elimina llamadas a BD y endpoints del servidor del HTML
 * @param {string} html - HTML a procesar
 * @returns {string} - HTML sin llamadas a BD
 */
function removeDatabaseCalls(html) {
    try {
        let cleanedHTML = html;
        let removedCount = 0;

        // Lista de endpoints que deben eliminarse
        const internalEndpoints = [
            '/public/getComponente',
            '/public/getComponentes',
            '/getComponenteObj',
            '/public/getTagImg',
            '/public/getTagDoc',
            '/public/getTagPag'
        ];

        // Eliminar scripts completos que contengan fetch a estos endpoints
        internalEndpoints.forEach(endpoint => {
            // Patrón para encontrar scripts completos que contengan fetch a este endpoint
            // Busca desde <script hasta </script> que contenga el fetch
            const scriptPattern = new RegExp(
                `<script[^>]*>[\\s\\S]*?fetch\\s*\\(\\s*['"]${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"][\\s\\S]*?<\\/script>`,
                'gi'
            );
            
            const matches = cleanedHTML.match(scriptPattern);
            if (matches) {
                removedCount += matches.length;
                cleanedHTML = cleanedHTML.replace(scriptPattern, 
                    '<!-- Script eliminado: llamada a ' + endpoint + ' - componentes ya renderizados estáticamente -->'
                );
            }

            // También eliminar bloques de código que usen Promise.all con fetch a estos endpoints
            const promiseAllPattern = new RegExp(
                `Promise\\.all\\s*\\([\\s\\S]*?fetch\\s*\\(\\s*['"]${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"][\\s\\S]*?\\)[\\s\\S]*?\\)[\\s\\S]*?\\)`,
                'gi'
            );
            
            const promiseMatches = cleanedHTML.match(promiseAllPattern);
            if (promiseMatches) {
                removedCount += promiseMatches.length;
                cleanedHTML = cleanedHTML.replace(promiseAllPattern,
                    '// Promise.all con fetch eliminado - componentes ya renderizados estáticamente'
                );
            }

            // Eliminar llamadas fetch individuales (por si no están en scripts completos)
            const fetchPattern = new RegExp(
                `fetch\\s*\\(\\s*['"]${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"][\\s\\S]*?\\)[\\s\\S]*?\\.then[\\s\\S]*?\\)`,
                'gi'
            );
            
            cleanedHTML = cleanedHTML.replace(fetchPattern,
                '// fetch eliminado - componente ya renderizado estáticamente'
            );

            // Eliminar $.ajax a estos endpoints
            const ajaxPattern = new RegExp(
                `\\$\\.ajax\\s*\\(\\s*\\{[\\s\\S]*?url:\\s*['"]${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"][\\s\\S]*?\\}\\s*\\)`,
                'gi'
            );
            
            cleanedHTML = cleanedHTML.replace(ajaxPattern,
                '// $.ajax eliminado - componente ya renderizado estáticamente'
            );
        });

        // Eliminar scripts que contengan "componentesParaRenderizar" (visorpaginas.ejs)
        const componentesParaRenderizarPattern = /<script[^>]*>[\s\S]*?componentesParaRenderizar[\s\S]*?<\/script>/gi;
        const componentesMatches = cleanedHTML.match(componentesParaRenderizarPattern);
        if (componentesMatches) {
            removedCount += componentesMatches.length;
            cleanedHTML = cleanedHTML.replace(componentesParaRenderizarPattern,
                '<!-- Script eliminado: componentesParaRenderizar - componentes ya renderizados estáticamente -->'
            );
        }

        // Eliminar código que busque elementos .pub_componente para renderizar dinámicamente
        const pubComponentePattern = /\$\(['"]\.pub_componente['"]\)[\s\S]*?\.each[\s\S]*?fetch[\s\S]*?getComponente[\s\S]*?\)[\s\S]*?\}\)/gi;
        cleanedHTML = cleanedHTML.replace(pubComponentePattern,
            '// Renderizado dinámico de .pub_componente eliminado - componentes ya renderizados estáticamente'
        );

        // Eliminar scripts que hagan fetch a /getComponenteObj (footercookie.ejs, editpag.ejs)
        const getComponenteObjScriptPattern = /<script[^>]*>[\s\S]*?fetch\s*\(\s*['"]\/getComponenteObj['"][\s\S]*?<\/script>/gi;
        const getComponenteObjMatches = cleanedHTML.match(getComponenteObjScriptPattern);
        if (getComponenteObjMatches) {
            removedCount += getComponenteObjMatches.length;
            cleanedHTML = cleanedHTML.replace(getComponenteObjScriptPattern,
                '<!-- Script eliminado: fetch a /getComponenteObj - componentes ya renderizados estáticamente -->'
            );
        }

        if (removedCount > 0) {
            console.log(`✅ ${removedCount} script(s) con llamadas a BD eliminado(s) del HTML`);
        } else {
            console.log('✅ No se encontraron llamadas a BD para eliminar');
        }

        return cleanedHTML;
    } catch (error) {
        console.error('Error removing database calls:', error);
        return html;
    }
}

/**
 * Procesa el HTML para convertir todas las imágenes a base64
 * @param {string} html - HTML a procesar
 * @returns {Promise<string>} - HTML con imágenes convertidas a base64
 */
async function processImagesInHTML(html) {
    try {
        // Buscar todas las imágenes en src, data-src, background-image, etc.
        const imagePatterns = [
            // src="..." o src='...' o src=... (sin comillas)
            /src\s*=\s*["']?([^"'\s>]+\.(png|jpg|jpeg|gif|svg|webp))["']?/gi,
            // data-src="..." o data-src='...' o data-src=... (sin comillas)
            /data-src\s*=\s*["']?([^"'\s>]+\.(png|jpg|jpeg|gif|svg|webp))["']?/gi,
            // background-image: url(...) - captura con o sin espacios, con o sin comillas
            /background-image\s*:\s*url\s*\(["']?([^"')]+\.(png|jpg|jpeg|gif|svg|webp))["']?\)/gi,
            // style="background-image: url(...)"
            /style=["'][^"']*background-image\s*:\s*url\s*\(["']?([^"')]+\.(png|jpg|jpeg|gif|svg|webp))["']?\)[^"']*["']/gi
        ];

        const imageUrls = new Set();
        const failedImages = [];
        
        // Recopilar todas las URLs de imágenes
        imagePatterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                const url = match[1];
                // Procesar TODAS las URLs que no sean data: ya procesadas
                // Incluir cdn.morena.app, /assets/, y URLs relativas
                if (url && !url.startsWith('data:')) {
                    // Si es una URL completa de cdn.morena.app, procesarla
                    if (url.startsWith('https://cdn.morena.app/')) {
                        imageUrls.add(url);
                    }
                    // Si es una ruta local (/assets/)
                    else if (url.startsWith('/assets/')) {
                        imageUrls.add(url);
                    }
                    // Si es una URL relativa sin http (puede ser storage_path + file_path concatenados)
                    else if (!url.startsWith('http') && !url.startsWith('//') && url.length > 3) {
                        // Verificar si parece una ruta de archivo
                        if (url.match(/\.(png|jpg|jpeg|gif|svg|webp)/i) || url.includes('/')) {
                            imageUrls.add(url);
                        }
                    }
                }
            }
        });

        console.log(`🖼️ Procesando ${imageUrls.size} imágenes para convertir a base64...`);
        console.log(`   - URLs encontradas: ${Array.from(imageUrls).slice(0, 5).join(', ')}${imageUrls.size > 5 ? '...' : ''}`);
        
        // Convertir cada imagen a base64
        const imageMap = new Map();
        let processedCount = 0;
        
        for (const imageUrl of imageUrls) {
            try {
                const base64 = await imageToBase64(imageUrl);
                if (base64 !== imageUrl && base64.startsWith('data:')) {
                    imageMap.set(imageUrl, base64);
                    processedCount++;
                    if (processedCount % 10 === 0) {
                        console.log(`  ✅ ${processedCount}/${imageUrls.size} imágenes procesadas...`);
                    }
                } else if (base64 === imageUrl) {
                    // La imagen no se pudo convertir (se mantuvo la URL original)
                    failedImages.push(imageUrl);
                    console.warn(`  ⚠️ Imagen no convertida (se mantiene URL original): ${imageUrl.substring(0, 80)}...`);
                }
            } catch (err) {
                failedImages.push(imageUrl);
                console.warn(`  ⚠️ Error procesando imagen ${imageUrl.substring(0, 80)}...:`, err.message);
            }
        }

        console.log(`✅ ${processedCount} imágenes convertidas a base64`);
        if (failedImages.length > 0) {
            console.warn(`⚠️ ${failedImages.length} imágenes NO se pudieron convertir a base64`);
            console.warn(`   - Estas imágenes mantendrán sus URLs originales`);
        }

        // Reemplazar todas las ocurrencias en el HTML
        let processedHTML = html;
        imageMap.forEach((base64, originalUrl) => {
            // Escapar caracteres especiales para regex
            const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // Reemplazar en diferentes contextos
            // src con comillas: src="/assets/img/..." o src='/assets/img/...'
            processedHTML = processedHTML.replace(
                new RegExp(`src\\s*=\\s*["']${escapedUrl}["']`, 'gi'),
                `src="${base64}"`
            );
            // src sin comillas: src=/assets/img/...
            processedHTML = processedHTML.replace(
                new RegExp(`src\\s*=\\s*${escapedUrl}(?=[\\s>])`, 'gi'),
                `src="${base64}"`
            );
            // data-src con comillas
            processedHTML = processedHTML.replace(
                new RegExp(`data-src\\s*=\\s*["']${escapedUrl}["']`, 'gi'),
                `data-src="${base64}"`
            );
            // data-src sin comillas
            processedHTML = processedHTML.replace(
                new RegExp(`data-src\\s*=\\s*${escapedUrl}(?=[\\s>])`, 'gi'),
                `data-src="${base64}"`
            );
            // background-image: url(...) con o sin espacios y comillas
            processedHTML = processedHTML.replace(
                new RegExp(`background-image\\s*:\\s*url\\s*\\(["']?${escapedUrl}["']?\\)`, 'gi'),
                `background-image: url("${base64}")`
            );
        });

        return processedHTML;
    } catch (error) {
        console.error('Error processing images in HTML:', error);
        return html;
    }
}

/**
 * Convierte una imagen local a base64
 * @param {string} imagePath - Ruta del archivo de imagen
 * @returns {string|null} Data URL base64 o null si falla
 */
function imageToBase64Local(imagePath) {
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
        return null;
    }
}

/**
 * Procesa imágenes en CSS y las convierte a base64
 * Maneja tanto rutas relativas (../img/...) como absolutas (/assets/img/...)
 * También maneja URLs de Google Cloud Storage (cdn.morena.app)
 * @param {string} cssContent - Contenido del CSS
 * @param {string} cssFilePath - Ruta completa del archivo CSS
 * @returns {Promise<string>} CSS con imágenes convertidas a base64
 */
async function processCssImages(cssContent, cssFilePath) {
    try {
        // Ruta base pública: app/src/public
        const publicBasePath = path.join(process.cwd(), 'app/src/public');
        
        // Regex mejorado para capturar todas las referencias a imágenes en CSS
        // IMPORTANTE: NO capturar URLs que ya están en base64 (data:image/...)
        // Captura: url(../img/...), url('/assets/img/...'), url("../assets/img/..."), url(../assets/img/...), etc.
        // También captura: url(https://cdn.morena.app/...)
        // PERO IGNORA: url(data:image/...)
        const cssImageRegex = /url\(["']?(?!data:)([^"')]+\.(png|jpg|jpeg|gif|svg|webp))["']?\)/gi;
        
        let processedCss = cssContent;
        let imageReplacements = 0;
        const processedUrls = new Map(); // Para evitar procesar la misma URL múltiples veces
        
        // Primero, recopilar todas las coincidencias
        const matches = [];
        let match;
        while ((match = cssImageRegex.exec(cssContent)) !== null) {
            // Limpiar la ruta: eliminar comillas simples y dobles, y espacios
            let imagePath = match[1].trim().replace(/^["']|["']$/g, '').trim();
            
            // Ignorar si ya es base64
            if (imagePath.startsWith('data:')) {
                continue;
            }
            
            matches.push({
                fullMatch: match[0],
                imagePath: imagePath,
                extension: match[2]
            });
        }
        
        // Procesar cada coincidencia de forma asíncrona
        // Usar un mapa para almacenar los reemplazos: ruta original -> base64
        const replacements = new Map();
        
        for (const matchData of matches) {
            const originalPath = matchData.imagePath;
            
            // Ignorar data URIs ya convertidas (doble verificación)
            if (originalPath.startsWith('data:')) {
                continue;
            }
            
            // Si ya procesamos esta URL, usar el resultado anterior
            if (processedUrls.has(originalPath)) {
                const base64 = processedUrls.get(originalPath);
                if (base64) {
                    replacements.set(originalPath, base64);
                    imageReplacements++;
                }
                continue;
            }
            
            let base64 = null;
            
            // Caso 1: URL de Google Cloud Storage (cdn.morena.app)
            if (originalPath.startsWith('https://cdn.morena.app/')) {
                try {
                    base64 = await imageToBase64(originalPath);
                    if (base64 && base64.startsWith('data:')) {
                        replacements.set(originalPath, base64);
                        imageReplacements++;
                        const shortPath = originalPath.length > 60 ? originalPath.substring(0, 60) + '...' : originalPath;
                        console.log(`   📷 Imagen CSS (GCS) convertida: ${shortPath}`);
                    }
                } catch (err) {
                    console.warn(`   ⚠️ Error procesando imagen GCS ${originalPath.substring(0, 60)}...:`, err.message);
                }
            }
            // Caso 2: URL externa (otro CDN) - mantenerla como está
            else if (originalPath.startsWith('http://') || originalPath.startsWith('https://')) {
                // Mantener URL externa sin convertir
                processedUrls.set(originalPath, null);
                continue;
            }
            // Caso 3: Ruta local - procesar archivo local
            else {
                let imageFilePath = null;
                
                // Caso 3a: Ruta absoluta que empieza con /assets/
                if (originalPath.startsWith('/assets/')) {
                    imageFilePath = path.join(publicBasePath, originalPath.replace(/^\//, ''));
                }
                // Caso 3b: Ruta relativa que empieza con ../
                else if (originalPath.startsWith('../')) {
                    // Resolver ruta relativa desde la ubicación del archivo CSS
                    // cssFilePath es algo como: app/src/public/assets/css/estilos.css
                    // originalPath es algo como: ../img/recursos_componentes/ILUSTRACION.png
                    // Resultado esperado: app/src/public/assets/img/recursos_componentes/ILUSTRACION.png
                    const cssDir = path.dirname(cssFilePath);
                    imageFilePath = path.resolve(cssDir, originalPath);
                }
                // Caso 3c: Ruta relativa sin ../
                else if (!originalPath.startsWith('/')) {
                    const cssDir = path.dirname(cssFilePath);
                    imageFilePath = path.resolve(cssDir, originalPath);
                }
                
                // Intentar convertir a base64
                if (imageFilePath && fs.existsSync(imageFilePath)) {
                    base64 = imageToBase64Local(imageFilePath);
                    if (base64) {
                        replacements.set(originalPath, base64);
                        imageReplacements++;
                        const relativePath = path.relative(publicBasePath, imageFilePath);
                        console.log(`   📷 Imagen CSS convertida: ${relativePath} (${(fs.statSync(imageFilePath).size / 1024).toFixed(2)} KB)`);
                    }
                } else if (imageFilePath) {
                    console.warn(`   ⚠️ Imagen CSS no encontrada: ${path.relative(publicBasePath, imageFilePath)}`);
                }
            }
            
            // Guardar resultado (incluso si es null) para evitar procesar de nuevo
            processedUrls.set(originalPath, base64);
        }
        
        // Aplicar todos los reemplazos al CSS
        // Buscar TODAS las ocurrencias de cada ruta y reemplazarlas con base64
        replacements.forEach((base64, originalPath) => {
            // Escapar la ruta para regex
            const escapedPath = originalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // Crear regex que busque url(...) con cualquier variación de espacios y comillas
            // pero que contenga la ruta exacta
            // Busca: url( seguido de espacios opcionales, comillas opcionales, la ruta, comillas opcionales, espacios opcionales, )
            const flexibleRegex = new RegExp(`url\\s*\\(\\s*["']?${escapedPath}["']?\\s*\\)`, 'gi');
            
            const beforeReplace = processedCss;
            processedCss = processedCss.replace(flexibleRegex, `url(${base64})`);
            
            // Log si no se hizo el reemplazo (para debugging)
            if (processedCss === beforeReplace) {
                console.warn(`   ⚠️ No se pudo reemplazar en CSS: ${originalPath.substring(0, 60)}...`);
                // Intentar buscar manualmente para debug
                const manualSearch = processedCss.indexOf(originalPath);
                if (manualSearch !== -1) {
                    console.warn(`   🔍 Ruta encontrada manualmente en posición ${manualSearch}, pero regex no funcionó`);
                }
            }
        });
        
        if (imageReplacements > 0) {
            console.log(`   ✅ ${imageReplacements} imagen(es) en CSS convertida(s) a base64`);
        }
        
        return processedCss;
    } catch (error) {
        console.error(`   ❌ Error procesando imágenes en CSS:`, error.message);
        return cssContent; // Devolver CSS original si hay error
    }
}

/**
 * Procesa imágenes en bloques <style> del HTML y las convierte a base64
 * @param {string} html - HTML con bloques <style>
 * @returns {Promise<string>} - HTML con imágenes en CSS convertidas a base64
 */
async function processCssInStyleTags(html) {
    try {
        // Buscar todos los bloques <style> en el HTML
        const styleTagRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
        let processedHtml = html;
        let styleTagCount = 0;
        let imageReplacements = 0;
        
        // Encontrar todos los bloques <style>
        const styleMatches = [];
        let match;
        while ((match = styleTagRegex.exec(html)) !== null) {
            styleMatches.push({
                fullMatch: match[0],
                cssContent: match[1],
                startIndex: match.index,
                endIndex: match.index + match[0].length
            });
        }
        
        // Ruta base pública para resolver rutas relativas en CSS inline
        const publicBasePath = path.join(process.cwd(), 'app/src/public');
        // Usar una ruta de archivo CSS ficticia en el directorio de assets/css para resolver rutas relativas correctamente
        const fakeCssPath = path.join(publicBasePath, 'assets/css/inline.css');
        
        // Procesar cada bloque <style> de atrás hacia adelante para no afectar los índices
        for (let i = styleMatches.length - 1; i >= 0; i--) {
            const styleMatch = styleMatches[i];
            const cssContent = styleMatch.cssContent;
            
            // Procesar imágenes en el CSS usando processCssImages
            const processedCss = await processCssImages(cssContent, fakeCssPath);
            
            if (processedCss !== cssContent) {
                // Reemplazar el contenido del bloque <style>
                const beforeStyle = processedHtml.substring(0, styleMatch.startIndex);
                const styleTagStart = html.substring(styleMatch.startIndex, html.indexOf('>', styleMatch.startIndex) + 1);
                const afterStyle = processedHtml.substring(styleMatch.endIndex);
                
                processedHtml = beforeStyle + styleTagStart + processedCss + '</style>' + afterStyle;
                imageReplacements++;
            }
            
            styleTagCount++;
        }
        
        if (imageReplacements > 0) {
            console.log(`   ✅ ${imageReplacements} bloque(s) <style> procesado(s) con imágenes convertidas a base64`);
        } else if (styleTagCount > 0) {
            console.log(`   ✅ ${styleTagCount} bloque(s) <style> revisado(s) (sin imágenes para convertir)`);
        }
        
        return processedHtml;
    } catch (error) {
        console.error('❌ Error procesando CSS en bloques <style>:', error.message);
        return html; // Devolver HTML original si hay error
    }
}

/**
 * Obtiene el contenido de un archivo CSS y lo convierte a inline
 * @param {string} cssPath - Ruta del archivo CSS
 * @returns {Promise<string>} - Contenido del CSS
 */
async function getCssContent(cssPath) {
    try {
        // La ruta correcta es: app/src/public/assets/css/...
        // Desde app/src/util/ necesitamos: ../public/
        const pathsToTry = [
            path.join(__dirname, '../public', cssPath),  // app/src/util/../public/ = app/src/public/
            path.join(__dirname, '../../src/public', cssPath),  // app/src/util/../../src/public/ = app/src/public/
            path.join(__dirname, '../../public', cssPath),  // app/src/util/../../public/ = app/public/
            path.join(process.cwd(), 'app/src/public', cssPath),  // Desde raíz del proyecto
            path.join(process.cwd(), 'src/public', cssPath)  // Alternativa
        ];
        
        for (const fullPath of pathsToTry) {
            if (fs.existsSync(fullPath)) {
                let content = fs.readFileSync(fullPath, 'utf8');
                if (content && content.trim().length > 0) {
                    const fileName = path.basename(cssPath);
                    const originalLength = content.length;
                    
                    // Procesar imágenes en el CSS y convertirlas a base64
                    console.log(`   🔄 Procesando imágenes en CSS: ${fileName}...`);
                    content = await processCssImages(content, fullPath);
                    
                    // Verificar si hubo cambios
                    const hasBase64 = content.includes('data:image');
                    if (hasBase64) {
                        const base64Count = (content.match(/data:image[^)]+/g) || []).length;
                        console.log(`   ✅ CSS procesado: ${fileName} - ${base64Count} imagen(es) convertida(s) a base64`);
                    } else {
                        console.log(`   ⚠️ CSS procesado: ${fileName} - No se encontraron imágenes para convertir`);
                    }
                    
                    // Solo log de tamaño para los primeros archivos
                    if (fileName === 'estilos_general.css' || fileName === 'estilos_componentes.css' || fileName === 'estilos_template.css') {
                        console.log(`✅ CSS cargado: ${cssPath} (${(content.length / 1024).toFixed(2)} KB)`);
                    }
                    return content;
                }
            }
        }
        
        console.warn(`⚠️ CSS no encontrado: ${cssPath} - Rutas probadas:`, pathsToTry.slice(0, 2));
        return '';
    } catch (error) {
        console.error(`❌ Error reading CSS file ${cssPath}:`, error.message);
        return '';
    }
}

/**
 * Obtiene todos los CSS y los concatena
 * @returns {Promise<string>} - Contenido de todos los CSS concatenados
 */
async function getAllCssContent() {
    const cssFiles = [
        '/assets/css/estilos_general.css',
        '/assets/css/estilos-general.css',
        '/assets/css/estilos_personal.css',
        '/assets/css/estilos_template.css',
        '/assets/css/estilos_componentes.css',
        '/assets/css/publictemplate.css',
        '/assets/css/menu.css',
        '/assets/css/menu_creacion.css',
        '/assets/css/error404.css',
        '/assets/css/cards-regeneracion.css',
        '/assets/css/cards-tag.css',
        '/assets/css/photogallery.css',
        '/assets/css/timeline.css',
        '/assets/css/footer.css',
        '/assets/css/buttons.css',
        '/assets/css/socialmedia.css',
        '/assets/css/subtitulo.css',
        '/assets/css/direccion.css',
        '/assets/css/titulos.css',
        '/assets/css/blog.css',
        '/assets/css/personas.css',
        '/assets/css/videos.css',
        '/assets/css/filepond.css',
        '/assets/css/filepond-plugin-image-preview.min.css',
        '/assets/css/filepond-plugin-image-preview.css',
        '/assets/css/free.gob.mx.css',
        '/assets/css/replacegmxtomorena.css'
    ];
    
    let allCss = '';
    let loadedCount = 0;
    let totalSize = 0;
    const failedFiles = [];
    
    // Procesar archivos CSS de forma secuencial para evitar problemas de concurrencia
    for (const cssFile of cssFiles) {
        const content = await getCssContent(cssFile);
        if (content && content.trim().length > 0) {
            allCss += `\n/* ===== ${cssFile} ===== */\n`;
            allCss += content;
            allCss += `\n`;
            loadedCount++;
            totalSize += content.length;
        } else {
            failedFiles.push(cssFile);
        }
    }
    
    console.log(`📊 CSS: ${loadedCount}/${cssFiles.length} archivos cargados (${(totalSize / 1024).toFixed(2)} KB total)`);
    
    if (failedFiles.length > 0) {
        console.warn(`⚠️ CSS no cargados (${failedFiles.length}):`, failedFiles.slice(0, 5));
    }
    
    // Verificar que los CSS principales estén cargados
    const criticalCss = ['estilos_general.css', 'estilos_componentes.css', 'estilos_template.css'];
    const hasCritical = criticalCss.some(file => allCss.includes(`/* ===== /assets/css/${file} ===== */`));
    
    if (!hasCritical && totalSize < 100000) {
        console.error('❌ ERROR: Los CSS principales no se cargaron correctamente!');
        console.error('   Tamaño total muy pequeño:', totalSize, 'caracteres');
    }
    
    return allCss;
}

/**
 * Obtiene el menú de la aplicación
 * @param {number} id_sysapp - ID de la aplicación
 * @returns {Promise<Array>} - Datos del menú
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

/**
 * Renderiza todos los componentes de una página y retorna el HTML completo
 * @param {Object} objpagina - Objeto de la página con sus componentes
 * @param {Object} objapp - Objeto de la aplicación
 * @returns {Promise<string>} - HTML renderizado de todos los componentes
 */
async function renderAllComponents(objpagina, objapp) {
    let htmlComponents = '';

    for (const seccion of objpagina.secciones || []) {
        for (const columna of seccion.columnas || []) {
            for (const componente of columna.componentes || []) {
                try {
                    const compResult = await publicController.renderComponente(
                        componente.tipoComponente.dataValues.table_componente,
                        componente.dataValues.id_wb_pag_componente,
                        objapp.id_sysapp
                    );
                    
                    if (compResult && compResult.rend) {
                        htmlComponents += compResult.rend;
                    }
                } catch (err) {
                    console.error(`Error rendering component ${componente.dataValues.id_wb_pag_componente}:`, err);
                }
            }
        }
    }

    return htmlComponents;
}

/**
 * Genera el HTML estático completo de una página
 * @param {number} id_wb_pagina - ID de la página
 * @param {Object} objapp - Objeto de la aplicación
 * @param {string} pagina_uri - URI de la página
 * @param {number} type_uri - Tipo de URI (1, 2, 5)
 * @returns {Promise<string>} - HTML estático completo
 */
async function generateStaticHTML(id_wb_pagina, objapp, pagina_uri, type_uri) {
    try {
        // Obtener datos de la página
        const paginas = await pagina.findAll({
            where: {
                id_wb_pagina: id_wb_pagina,
                vigente: true,
                publicada: true
            },
            include: [{
                model: require('../models/paginasModel').seccion,
                as: 'secciones',
                required: false,
                where: { vigente: true },
                include: [{
                    model: require('../models/paginasModel').columna,
                    as: 'columnas',
                    required: false,
                    where: { vigente: true },
                    include: [{
                        model: require('../models/paginasModel').componente,
                        as: 'componentes',
                        required: false,
                        where: { vigente: true },
                        include: [{
                            model: require('../models/paginasModel').tipoComponente,
                            as: 'tipoComponente',
                            required: false,
                            where: { vigente: true },
                        }],
                    }],
                }],
            }],
            subQuery: false,
            order: [
                ['id_wb_pagina', 'DESC'],
                require('sequelize').literal('secciones.orden_visible ASC,"secciones->columnas".orden_visible ASC, "secciones->columnas->componentes".orden_visible ASC')
            ],
        });

        if (!paginas || paginas.length === 0) {
            throw new Error('Página no encontrada o no publicada');
        }

        const objpagina = paginas[0];

        // Renderizar todos los componentes
        const componentsHTML = await renderAllComponents(objpagina, objapp);

        // Obtener menú
        let menuData = [];
        try {
            const menuId = await menuModel.menu.findOne({
                where: {
                    fk_id_sysapp: objapp.id_sysapp,
                    vigente: true,
                },
                raw: true,
            });

            if (menuId) {
                menuData = await obtenerMenuPorNivel(menuId.id_wb_menu, null);
            }
        } catch (menuErr) {
            console.error('Error fetching menu for static render:', menuErr);
        }

        const classtop = objapp.fk_id_sysapp_type === 2 ? 'top_prim' : 'top_sec';

        // Leer templates
        const headerPath = path.join(__dirname, '../views/publics/partials/header.ejs');
        const footerPath = path.join(__dirname, '../views/publics/partials/footer.ejs');
        const menuPath = path.join(__dirname, '../views/publics/partials/menu.ejs');

        let headerTemplate = fs.readFileSync(headerPath, 'utf8');
        const footerTemplate = fs.readFileSync(footerPath, 'utf8');

        // Renderizar menú primero (necesitamos generar el HTML del menú estático)
        const menuHTML = await renderMenuStatic(menuData, objapp);

        // Reemplazar el include del menú en el header antes de renderizar
        // Buscar y reemplazar cualquier variación del include
        headerTemplate = headerTemplate.replace(
            /<%-?\s*include\s*\(?\s*['"]menu['"]\s*\)?\s*;?\s*%>/gi,
            menuHTML
        );
        
        // También buscar includes con rutas relativas
        headerTemplate = headerTemplate.replace(
            /<%-?\s*include\s*\(?\s*['"]partials\/menu['"]\s*\)?\s*;?\s*%>/gi,
            menuHTML
        );

        // Configurar opciones de EJS para resolver includes
        const viewsPath = path.join(__dirname, '../views');
        const partialsPath = path.join(__dirname, '../views/publics/partials');

        // Renderizar header con el menú ya incluido
        const headerHTML = ejs.render(headerTemplate, {
            dataapp: objapp,
            datapagina: objpagina,
            classtop
        }, {
            filename: headerPath,
            views: [viewsPath, partialsPath]
        });

        // Renderizar footer
        const footerHTML = ejs.render(footerTemplate, {
            dataapp: objapp,
            datapagina: objpagina,
            classtop
        }, {
            filename: footerPath,
            views: [viewsPath, partialsPath]
        });

        // Construir estructura de secciones y columnas EXACTAMENTE como visorpaginas.ejs
        // pero con los componentes YA renderizados (no divs vacíos)
        let seccionesHTML = '<div id="contPub" class="container">';
        let i = 0;
        
        console.log(`📦 Renderizando ${objpagina.secciones?.length || 0} secciones...`);
        
        for (const seccion of objpagina.secciones || []) {
            const cols = parseInt(seccion.dataValues.wb_num_col) || 1;
            const colvalue = 12 / cols;
            
            // Estructura EXACTA de visorpaginas.ejs
            seccionesHTML += `<div class="row pub_seccion " id="seccion_${seccion.dataValues.id_wb_pag_seccion}" data-origen="saved" data-sec="${seccion.dataValues.id_wb_pag_seccion}" data-orden="${i}">`;
            
            let c = 0;
            for (const columna of seccion.columnas || []) {
                seccionesHTML += `<div class="col-md-${colvalue} pub_columna" id="columna_${columna.dataValues.id_wb_pag_columna}" data-origen="saved" data-idcol="${columna.dataValues.id_wb_pag_columna}" data-orden="${columna.dataValues.orden_visible}">`;
                
                let cp = 0;
                for (const componente of columna.componentes || []) {
                    const validcomp = `${i}-${c}-${cp}`;
                    try {
                        console.log(`  🔧 Renderizando componente ${componente.dataValues.id_wb_pag_componente} (${componente.tipoComponente.dataValues.table_componente})...`);
                        
                        // Renderizar el componente COMPLETO - esto incluye HTML + CSS inline + JS inline del componente
                        const compResult = await publicController.renderComponente(
                            componente.tipoComponente.dataValues.table_componente,
                            componente.dataValues.id_wb_pag_componente,
                            objapp.id_sysapp
                        );
                        
                        if (compResult && compResult.rend && compResult.rend.trim().length > 0) {
                            // Incluir el HTML renderizado directamente - este es el HTML COMPLETO del componente
                            // que incluye su estructura, estilos inline y JavaScript inline
                            seccionesHTML += compResult.rend;
                            console.log(`    ✅ Componente renderizado (${compResult.rend.length} caracteres)`);
                        } else {
                            console.warn(`    ⚠️ Componente ${componente.dataValues.id_wb_pag_componente} no retornó HTML`);
                        }
                    } catch (err) {
                        console.error(`    ❌ Error rendering component ${componente.dataValues.id_wb_pag_componente}:`, err.message);
                        if (err.stack) {
                            console.error(err.stack);
                        }
                    }
                    cp++;
                }
                
                seccionesHTML += '</div>';
                c++;
            }
            
            seccionesHTML += '</div>';
            i++;
        }
        seccionesHTML += '</div>';
        
        console.log(`✅ Secciones renderizadas: ${i} secciones`);

        // Construir HTML completo usando header y footer renderizados
        // Extraer solo el body del header y footer
        const headerBodyMatch = headerHTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        const headerBody = headerBodyMatch ? headerBodyMatch[1] : '';
        
        const footerBodyMatch = footerHTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        const footerBody = footerBodyMatch ? footerBodyMatch[1] : '';
        
        // Extraer head del header (solo meta tags y scripts, no los links CSS)
        const headMatch = headerHTML.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
        let headContent = headMatch ? headMatch[1] : '';
        
        // Remover los links CSS del head porque los incluiremos inline
        headContent = headContent.replace(/<link[^>]*href=["'][^"']*\.css[^"']*["'][^>]*>/gi, '');
        
        // Obtener TODOS los CSS antes de construir el HTML
        console.log('📦 Cargando todos los CSS...');
        const allCssContent = await getAllCssContent();
        const cssSizeKB = (allCssContent.length / 1024).toFixed(2);
        console.log(`✅ CSS cargado: ${cssSizeKB} KB`);
        
        if (allCssContent.length === 0) {
            console.error('❌ ERROR CRÍTICO: No se cargó ningún CSS! Verifica las rutas.');
            throw new Error('No se pudieron cargar los archivos CSS. El HTML estático no tendrá estilos.');
        }
        
        // Verificar que los CSS principales estén presentes
        const hasEstilosGeneral = allCssContent.includes('.container') || allCssContent.includes('body') || allCssContent.length > 50000;
        if (!hasEstilosGeneral) {
            console.warn('⚠️ ADVERTENCIA: Los CSS pueden no estar cargados correctamente');
        } else {
            console.log('✅ CSS principales verificados: Contenido CSS presente');
        }
        
        // Construir HTML completo con TODOS los CSS inline
        let fullHTML = `<!doctype html>
<html lang="es" data-bs-theme="auto">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${objapp.app_legend || ''} ${objpagina.nombre_pagina || ''}</title>
    <link rel="icon" type="image/x-icon" href="${objapp.app_favicon || ''}">
    <meta name="description" content="${(objpagina.contenido_alt || '').replace(/"/g, '&quot;')} | ${(objapp.app_desc || '').replace(/"/g, '&quot;')}">

    <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css" integrity="sha512-Kc323vGBEqzTmouAECnVceyQqyqdsSiqLQISBL29aUW4U/M7pSPA/gEUZQqv1cwx4OnYxTxve5UMg5GT6L4JJg==" crossorigin="anonymous" referrerpolicy="no-referrer" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-1BmE4kWBq78iYhFldvKuhfTAU6auU8tT94WrHftjDbrCEXSU1oBoqyl2QvZ6jIW3" crossorigin="anonymous">
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-ka7Sk0Gln4gmtz2MlQnikT1wXgYsOg+OMhuP+IlRH9sENBO0LRn5q+8nbTov4+1p" crossorigin="anonymous"></script>
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,500,600,700,900&amp;display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/jquery-confirm/3.3.2/jquery-confirm.min.css">
    <script src="https://code.jquery.com/jquery-3.6.4.min.js"></script>
    <script src="https://www.google.com/recaptcha/api.js"></script>
    <link rel="stylesheet" href="https://cdn.datatables.net/1.13.5/css/jquery.dataTables.css" />
    <script src="https://cdn.datatables.net/1.13.5/js/jquery.dataTables.js"></script>
    <script src="assets/js/filepond-plugin-image-preview.min.js"></script>
    <script src="assets/js/filepond-plugin-image-exif-orientation.min.js"></script>
    <script src="assets/js/filepond-plugin-file-validate-size.min.js"></script>
    <script src="assets/js/filepond-plugin-image-edit.min.js"></script>
    <script src="assets/js/filepond-plugin-file-encode.min.js"></script>
    <script src="https://unpkg.com/filepond@^4/dist/filepond.min.js"></script>
    <script src="https://unpkg.com/filepond-plugin-file-validate-type/dist/filepond-plugin-file-validate-type.min.js"></script>

    <!-- CSS Inline - Todos los estilos propios incluidos -->
    <style>
${allCssContent}
    </style>
</head>
<body>
${headerBody}
<main class="${classtop}">
    ${menuHTML}
    ${seccionesHTML}
</main>
${footerBody}
<script>
    // Scripts necesarios para que la página funcione correctamente
    let tipo_p='1';
    if(tipo_p==='1') {
        $('#lockscreen').show();
        setTimeout(() => {
            $('#lockscreen').css('opacity',0);
            setTimeout(() => {
                $('#lockscreen').hide();
            }, 1000);
        }, 1000);
    }
    $(document).ready(function () {
        // Los componentes ya están renderizados estáticamente, no necesitan fetch
        // Los componentes tienen su propio JavaScript inline que se ejecutará automáticamente
        console.log('✅ Página estática cargada - Componentes ya renderizados');
        
        // Inicializar cualquier funcionalidad adicional que necesiten los componentes
        // Los componentes individuales (carousel, acordeon, etc.) tienen su propio JS inline
    });
</script>
</body>
</html>`;

        // Procesar imágenes en bloques <style> del HTML (CSS inline)
        console.log('🎨 Procesando imágenes en bloques <style> del HTML...');
        fullHTML = await processCssInStyleTags(fullHTML);

        // Procesar imágenes para convertir a base64
        console.log('🖼️ Procesando imágenes en el HTML...');
        fullHTML = await processImagesInHTML(fullHTML);

        // Eliminar cualquier llamada a BD o endpoints del servidor
        console.log('🔒 Eliminando llamadas a BD y endpoints del servidor...');
        fullHTML = removeDatabaseCalls(fullHTML);

        // RESUMEN FINAL: Verificar qué recursos están incluidos
        console.log('\n📊 RESUMEN FINAL DE RECURSOS INCLUIDOS:');
        const cssIncluded = (fullHTML.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).length;
        const cssSize = fullHTML.match(/<style[^>]*>([\s\S]*?)<\/style>/i) ? 
                       fullHTML.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1].length : 0;
        const imagesBase64 = (fullHTML.match(/src=["']data:image\/[^"']+["']/gi) || []).length;
        const imagesExternal = (fullHTML.match(/src=["']https?:\/\/[^"']+["']/gi) || []).length;
        const scriptsIncluded = (fullHTML.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []).length;
        
        console.log(`   ✅ CSS: ${cssIncluded} bloques <style> incluidos (${(cssSize / 1024).toFixed(2)} KB)`);
        console.log(`   ✅ Imágenes: ${imagesBase64} convertidas a base64, ${imagesExternal} URLs externas`);
        console.log(`   ✅ Scripts: ${scriptsIncluded} bloques <script> incluidos`);
        console.log(`   ✅ HTML completo: ${(fullHTML.length / 1024).toFixed(2)} KB`);
        
        if (cssSize < 50000) {
            console.warn(`   ⚠️ ADVERTENCIA: El CSS parece muy pequeño (${(cssSize / 1024).toFixed(2)} KB)`);
            console.warn(`   - Verifica que todos los archivos CSS se hayan incluido correctamente`);
        }
        
        if (imagesBase64 === 0 && imagesExternal > 0) {
            console.warn(`   ⚠️ ADVERTENCIA: No se convirtieron imágenes a base64`);
            console.warn(`   - Las imágenes pueden no funcionar sin conexión a internet`);
        }
        
        console.log('✅ HTML estático generado completamente\n');

        return fullHTML;
    } catch (error) {
        console.error('Error generating static HTML:', error);
        throw error;
    }
}

/**
 * Renderiza el menú de forma estática
 * @param {Array} menuData - Datos del menú
 * @param {Object} objapp - Objeto de la aplicación
 * @returns {Promise<string>} - HTML del menú renderizado
 */
async function renderMenuStatic(menuData, objapp) {
    try {
        // Generar HTML del menú directamente (sin usar el template que tiene fetch)
        let menuHTML = `
<div class="overlay" id="overlay"></div>
<nav class="menu">
    <div class="logo">
        <img src="/assets/img/logo_morena.png" alt="logo" />
    </div>
    <div class="menu-toggle" id="menu-toggle">
        <i class="fas fa-bars toggle"></i>
    </div>
    <ul class="menu-list" id="menu-list">`;

        // Renderizar items del menú
        if (menuData && menuData.length > 0) {
            menuData.forEach(itemNivel1 => {
                const tieneSubmenus = itemNivel1.submenus && itemNivel1.submenus.length > 0;
                const href = itemNivel1.url_link || '#';
                
                menuHTML += `<li><a href="${href}" class="${tieneSubmenus ? 'submenu-toggle' : ''}"${tieneSubmenus ? ` data-target="submenu-${itemNivel1.id_wb_menu_link}"` : ''}>`;
                menuHTML += `<span>${itemNivel1.nombre}</span>`;
                if (tieneSubmenus) {
                    menuHTML += `<i class="fa-solid fa-chevron-down chevron"></i>`;
                }
                menuHTML += `</a>`;
                
                if (tieneSubmenus) {
                    menuHTML += `<div class="submenu-container" id="submenu-${itemNivel1.id_wb_menu_link}">`;
                    menuHTML += `<div class="submenu-content">`;
                    const imgUrl = itemNivel1.url_imagen || '/assets/img/img-menu.png';
                    menuHTML += `<ul class="submenu-column level-0"><li><img class="submenuImg" src="${imgUrl}" alt="${itemNivel1.nombre}"></li></ul>`;
                    menuHTML += renderSubmenusStatic(itemNivel1.submenus, 2);
                    menuHTML += `</div></div>`;
                }
                
                menuHTML += `</li>`;
            });
        }

        menuHTML += `</ul>
</nav>`;

        // Incluir JS del menú inline (misma lógica que menu_static.ejs para subniveles)
        const menuJS = `
function inicializarMenu(){
    var menuBreakpoint = 965;
    $('#menu-toggle').click(function(){
        $('#menu-list').slideToggle(300);
        if ($(window).width() <= menuBreakpoint) { $('#overlay').fadeIn(); }
    });
    var lastViewDesktop = $(window).width() > menuBreakpoint;
    $(window).off('resize.menuResize').on('resize.menuResize', function() {
        var nowDesktop = $(window).width() > menuBreakpoint;
        if (nowDesktop === lastViewDesktop) return;
        lastViewDesktop = nowDesktop;
        if (nowDesktop) {
            $('#menu-list').show().css('display','flex');
            $('.submenu-container').hide().removeClass('active');
            $('.chevron').removeClass('rotate');
            $('#overlay').fadeOut();
        } else { $('#menu-list').hide(); }
    });
    function closeOtherSubmenus(current) {
        $('.submenu-container').not(current).slideUp(300).removeClass('active align-right').css('max-width','');
        $('.submenu-toggle .chevron').not($(current).prev().find('.chevron')).removeClass('rotate');
        $('#overlay').fadeOut();
    }
    function closeAllSubLevels() {
        $('.submenu-column.level-3, .submenu-column.level-4').hide().removeClass('active');
        $('.submenu-container').removeClass('active');
        $('.chevron').removeClass('rotate');
    }
    $(document).on('click', '.submenu-toggle, .imgMenu', function(e){
        var $act = $(this).hasClass('submenu-toggle') ? $(this) : $(this).find('a').first();
        if (!$act.length) return;
        var isMainToggle = $act.hasClass('submenu-toggle');
        if (!isMainToggle && $act.find('.chevron').length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (isMainToggle) {
            var target = $act.data('target');
            var submenu = $('#' + target);
            var chevron = $act.find('.chevron');
            if (submenu.hasClass('active')) {
                submenu.slideUp(300).removeClass('active align-right').css('max-width','');
                chevron.removeClass('rotate');
                $('#overlay').fadeOut();
                submenu.find('.submenu-column.level-2, .submenu-column.level-3, .submenu-column.level-4').removeClass('submenu-column-open').hide();
            } else {
                closeOtherSubmenus(submenu);
                submenu.removeClass('align-right').css('max-width','');
                submenu.find('.submenu-column.level-2, .submenu-column.level-3, .submenu-column.level-4').removeClass('submenu-column-open').hide();
                var $li = submenu.closest('li');
                if ($li.length) {
                    var margin = 24;
                    var winW = $(window).width();
                    var liLeft = $li.offset().left;
                    var liRight = liLeft + $li.outerWidth();
                    var maxWLeft = winW - liLeft - margin;
                    var maxWRight = liRight - margin;
                    var dropdownMax = 2000;
                    if (maxWLeft >= maxWRight) {
                        submenu.removeClass('align-right');
                        submenu.css('max-width', Math.max(300, Math.min(dropdownMax, maxWLeft)) + 'px');
                    } else {
                        submenu.addClass('align-right');
                        submenu.css('max-width', Math.max(300, Math.min(dropdownMax, maxWRight)) + 'px');
                    }
                }
                submenu.slideDown(300).addClass('active');
                chevron.addClass('rotate');
                $('#overlay').fadeIn();
                submenu.find('.submenu-column.level-3, .submenu-column.level-4').removeClass('submenu-column-open').hide();
                submenu.find('.submenu-column.level-2').addClass('submenu-column-open').show();
            }
        } else {
            var $container = $act.closest('.submenu-container');
            var $submenuColumn = $act.closest('.submenu-column');
            var classAttr = $submenuColumn.attr('class') || '';
            var levelMatch = classAttr.match(/level-(\\d+)/);
            if (!levelMatch) return;
            var currentLevel = parseInt(levelMatch[1], 10);
            var nextLevel = currentLevel + 1;
            var $lisConHijos = $submenuColumn.find('> li').has('.chevron');
            var indice = $lisConHijos.index($act.closest('li'));
            if (indice < 0) return;
            var $siguientes = $submenuColumn.nextAll('.submenu-column');
            var $columnasSiguienteNivel = $();
            $siguientes.each(function() {
                var $el = $(this);
                if ($el.hasClass('level-' + currentLevel)) return false;
                if ($el.hasClass('level-' + nextLevel)) $columnasSiguienteNivel = $columnasSiguienteNivel.add($el);
            });
            var $nextLevelColumn = $columnasSiguienteNivel.eq(indice);
            if ($nextLevelColumn.length === 0) return;
            if ($nextLevelColumn.hasClass('submenu-column-open')) {
                $nextLevelColumn.slideUp(300).removeClass('active submenu-column-open');
                $act.find('.chevron').removeClass('rotate');
                $nextLevelColumn.nextAll('.submenu-column').hide().removeClass('active submenu-column-open');
                $nextLevelColumn.find('.chevron').removeClass('rotate');
            } else {
                $container.find('.submenu-column.level-' + nextLevel).not($nextLevelColumn).removeClass('submenu-column-open').hide().removeClass('active');
                $container.find('.submenu-column').each(function() {
                    var $col = $(this);
                    var lm = ($col.attr('class') || '').match(/level-(\\d+)/);
                    if (lm && parseInt(lm[1], 10) > nextLevel) {
                        $col.removeClass('submenu-column-open').hide().removeClass('active');
                        $col.find('.chevron').removeClass('rotate');
                    }
                });
                $nextLevelColumn.addClass('submenu-column-open active').css('display','flex').show();
                $nextLevelColumn.slideDown(300);
                $act.find('.chevron').addClass('rotate');
            }
        }
    });
    $('#overlay').click(function(){
        $('.submenu-container').slideUp(300).removeClass('active align-right').css('max-width','');
        $('.chevron').removeClass('rotate');
        $(this).fadeOut();
        closeAllSubLevels();
        if ($(window).width() <= menuBreakpoint) {
            $('#menu-list').slideUp(300);
        }
    });
}
$(document).ready(function () { inicializarMenu(); });`;

        menuHTML += `<script>${menuJS}</script>`;

        return menuHTML;
    } catch (error) {
        console.error('Error rendering menu static:', error);
        // Fallback a HTML básico si falla
        return `
<div class="overlay" id="overlay"></div>
<nav class="menu">
    <div class="logo">
        <img src="/assets/img/logo_morena.png" alt="logo" />
    </div>
    <div class="menu-toggle" id="menu-toggle">
        <i class="fas fa-bars toggle"></i>
    </div>
    <ul class="menu-list" id="menu-list"></ul>
</nav>`;
    }
}

/**
 * Renderiza submenús de forma recursiva (level 2 = primera columna, igual que menu.ejs)
 * @param {Array} items - Items del submenú
 * @param {number} level - Nivel actual (2, 3, 4...)
 * @returns {string} - HTML de los submenús
 */
function renderSubmenusStatic(items, level = 2) {
    if (!items || items.length === 0) return '';
    
    let html = `<ul class="submenu-column level-${level}">`;
    items.forEach(item => {
        const tieneSubmenus = item.submenus && item.submenus.length > 0;
        const href = item.url_link || '#';
        html += `<li class="imgMenu"><a href="${href}">`;
        html += `<span>${item.nombre}</span>`;
        if (tieneSubmenus) {
            html += `<i class="fa-solid fa-chevron-right chevron"></i>`;
        }
        html += `</a></li>`;
    });
    html += `</ul>`;
    // Columnas del siguiente nivel como hermanas (no dentro del ul), igual que menu.ejs
    items.forEach(item => {
        if (item.submenus && item.submenus.length > 0) {
            html += renderSubmenusStatic(item.submenus, level + 1);
        }
    });
    return html;
}

/**
 * Genera un hash para el nombre del archivo
 * @param {string} url - URL de la página
 * @returns {string} - Hash SHA256
 */
function generateFileHash(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
}

/**
 * Genera y guarda el archivo HTML estático
 * @param {number} id_wb_pagina - ID de la página
 * @param {Object} objapp - Objeto de la aplicación
 * @param {string} pagina_uri - URI de la página
 * @param {number} type_uri - Tipo de URI
 * @returns {Promise<string>} - Ruta del archivo generado
 */
async function generateAndSaveStaticPage(id_wb_pagina, objapp, pagina_uri, type_uri) {
    try {
        // Generar HTML estático
        const htmlContent = await generateStaticHTML(id_wb_pagina, objapp, pagina_uri, type_uri);

        // Construir URL para el hash (usar la misma lógica que dashController)
        const normalizeUrl = (u = '') => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const appUrlNorm = normalizeUrl(objapp.urluri || '');
        let fullUrlForHash = appUrlNorm;
        
        // Agregar página URI si no es home
        if (pagina_uri && pagina_uri !== '/' && type_uri !== 1) {
            fullUrlForHash = `${appUrlNorm}/${pagina_uri}`;
        }
        
        const fileHash = generateFileHash(fullUrlForHash);

        // Crear directorio dist si no existe
        const distDir = path.join(__dirname, '../../dist', String(objapp.id_sysapp));
        if (!fs.existsSync(distDir)) {
            fs.mkdirSync(distDir, { recursive: true });
        }

        // NO ofuscar JavaScript - esto rompe los métodos de jQuery como .carousel(), .trigger(), etc.
        // La ofuscación convierte .carousel() en .a3() y rompe el código
        
        // Minificar HTML (pero PRESERVAR los scripts JavaScript sin ofuscar)
        // IMPORTANTE: NO usar minifyJS porque ofusca métodos de jQuery y rompe el código
        let minifiedHTML;
        try {
            minifiedHTML = minify(htmlContent, {
                removeAttributeQuotes: true,
                collapseWhitespace: true,
                removeComments: true,  // Eliminar comentarios HTML
                minifyJS: false,  // ❌ DESACTIVADO - ofusca métodos de jQuery y rompe el código
                minifyCSS: false,  // NO minificar CSS para evitar problemas - ya está optimizado
                collapseBooleanAttributes: true,
                removeRedundantAttributes: true,
                useShortDoctype: true,
                removeEmptyAttributes: true,
                removeOptionalTags: false,  // NO eliminar tags opcionales
                removeScriptTypeAttributes: true,
                removeStyleLinkTypeAttributes: true,
                minifyURLs: false,  // ❌ DESACTIVADO - puede romper base64 en CSS
                preserveLineBreaks: false,
                keepClosingSlash: false,
                caseSensitive: false
            });
        } catch (minifyError) {
            console.error('❌ Error al minificar HTML:', minifyError.message);
            console.log('Usando HTML sin minificar...');
            minifiedHTML = htmlContent;
        }
        
        // Verificar que el CSS esté presente después de minificar
        const styleMatch = minifiedHTML.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
        if (!styleMatch) {
            console.error('❌ ERROR CRÍTICO: Los estilos se perdieron durante la minificación!');
            console.error('Usando HTML sin minificar para preservar estilos...');
            // Si se perdieron los estilos, usar HTML sin minificar pero con CSS preservado
            const filePath = path.join(distDir, `${fileHash}.html`);
            fs.writeFileSync(filePath, htmlContent, 'utf8');
            console.log(`✅ Archivo estático generado SIN minificar (para preservar estilos): ${filePath}`);
            return filePath;
        }
        
        const cssSize = styleMatch[1].length;
        console.log(`✅ CSS preservado después de minificación: ${(cssSize / 1024).toFixed(2)} KB`);
        
        // Verificar que los CSS principales estén presentes (buscar clases comunes)
        const cssContent = styleMatch[1];
        const hasMainStyles = cssContent.includes('.container') || 
                             cssContent.includes('body') || 
                             cssContent.includes('.row') ||
                             cssContent.includes('.col-md') ||
                             cssSize > 50000;
        
        if (!hasMainStyles) {
            console.error('❌ ERROR: Los CSS principales NO están incluidos!');
            console.error(`   Tamaño del CSS: ${cssSize} caracteres (debería ser > 200KB)`);
            console.error('   Usando HTML sin minificar para preservar estilos...');
            const filePath = path.join(distDir, `${fileHash}.html`);
            fs.writeFileSync(filePath, htmlContent, 'utf8');
            console.log(`✅ Archivo estático generado SIN minificar: ${filePath}`);
            return filePath;
        } else {
            console.log(`✅ CSS principales verificados: ${cssSize} caracteres de CSS incluidos`);
        }

        // Guardar archivo
        const filePath = path.join(distDir, `${fileHash}.html`);
        fs.writeFileSync(filePath, minifiedHTML, 'utf8');

        console.log(`✅ Archivo estático generado: ${filePath}`);
        return filePath;
    } catch (error) {
        console.error('Error generating static page:', error);
        throw error;
    }
}

/**
 * Elimina el archivo HTML estático de una página
 * @param {Object} objapp - Objeto de la aplicación
 * @param {string} pagina_uri - URI de la página
 * @returns {Promise<boolean>} - true si se eliminó, false si no existía
 */
async function deleteStaticPage(objapp, pagina_uri) {
    try {
        // Construir URL para el hash (usar la misma lógica que dashController)
        const normalizeUrl = (u = '') => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const appUrlNorm = normalizeUrl(objapp.urluri || '');
        let fullUrlForHash = appUrlNorm;
        
        // Agregar página URI si no es home
        if (pagina_uri && pagina_uri !== '/') {
            fullUrlForHash = `${appUrlNorm}/${pagina_uri}`;
        }
        
        const fileHash = generateFileHash(fullUrlForHash);

        const distDir = path.join(__dirname, '../../dist', String(objapp.id_sysapp));
        const filePath = path.join(distDir, `${fileHash}.html`);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`✅ Archivo estático eliminado: ${filePath}`);
            return true;
        }

        return false;
    } catch (error) {
        console.error('Error deleting static page:', error);
        return false;
    }
}

/**
 * Verifica si existe un archivo estático para una URL
 * @param {Object} objapp - Objeto de la aplicación
 * @param {string} pagina_uri - URI de la página
 * @returns {Promise<string|null>} - Ruta del archivo si existe, null si no
 */
async function getStaticPagePath(objapp, pagina_uri) {
    try {
        // Construir URL para el hash (usar la misma lógica que dashController)
        const normalizeUrl = (u = '') => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const appUrlNorm = normalizeUrl(objapp.urluri || '');
        let fullUrlForHash = appUrlNorm;
        
        // Agregar página URI si no es home
        if (pagina_uri && pagina_uri !== '/') {
            fullUrlForHash = `${appUrlNorm}/${pagina_uri}`;
        }
        
        const fileHash = generateFileHash(fullUrlForHash);

        const distDir = path.join(__dirname, '../../dist', String(objapp.id_sysapp));
        const filePath = path.join(distDir, `${fileHash}.html`);

        if (fs.existsSync(filePath)) {
            // Retornar ruta absoluta
            return path.resolve(filePath);
        }

        return null;
    } catch (error) {
        console.error('Error getting static page path:', error);
        return null;
    }
}

module.exports = {
    generateAndSaveStaticPage,
    deleteStaticPage,
    getStaticPagePath,
    generateStaticHTML,
    processCssImages
};
