const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const { Op } = require('sequelize');
const { compareDates } = require('../util/util');
const paginaModel = require('../models/paginasModel');
const utilFun = require('../util/util');
const { seccion, columna, componente, tipoComponente } = require('../models/paginasModel');

// Configuración de componentes
const COMPONENT_CONFIG = {
    1: { name: 'Título de página', table: 'wb_comp_titulopag', minSize: 12, requiredFields: ['titulo', 'texto'], hasFile: true },
    2: { name: 'Subtítulo', table: 'wb_comp_subtitulo', minSize: 3, requiredFields: ['texto'], hasFile: false },
    3: { name: 'Texto', table: 'wb_comp_texto', minSize: 3, requiredFields: ['texto'], hasFile: false },
    4: { name: 'Botón', table: 'wb_comp_boton', minSize: 3, requiredFields: ['texto', 'liga'], hasFile: false },
    5: { name: 'Carrusel', table: 'wb_comp_carrousel', minSize: 12, requiredFields: ['titulo_slides', 'text_slides', 'text_btn_slides', 'url_slides'], hasFile: true, hasSlides: true },
    7: { name: 'Flip Card', table: 'wb_comp_flip', minSize: 3, requiredFields: ['titulo', 'texto', 'url_link'], hasFile: true },
    8: { name: 'Noticias', table: 'wb_comp_noticias', minSize: 12, requiredFields: ['fk_id_cat_tag'], hasFile: false },
    9: { name: 'Acordeón', table: 'wb_comp_acordeon', minSize: 12, requiredFields: [], hasFile: false, special: true },
    10: { name: 'Galería', table: 'wb_comp_galeria', minSize: 12, requiredFields: ['titulo_slides', 'text_slides'], hasFile: true, hasSlides: true },
    13: { name: 'Cards', table: 'wb_comp_cards', minSize: 3, requiredFields: ['titulo', 'url_link'], hasFile: true },
    14: { name: 'Línea de tiempo', table: 'wb_comp_linea', minSize: 12, requiredFields: ['titulo_slides', 'text_slides', 'anio_slides'], hasFile: true, hasSlides: true },
    16: { name: 'Redes sociales', table: 'wb_comp_redes', minSize: 12, requiredFields: [], hasFile: false, socialNetworks: ['facebook', 'instagram', 'tiktok', 'twitter', 'youtube'] },
    17: { name: 'Cards Regeneración', table: 'wb_comp_cards_regeneracion', minSize: 12, requiredFields: ['anio_seleccionado'], hasFile: false, special: true },
    20: { name: 'Imagen', table: 'wb_comp_img', minSize: 3, requiredFields: [], hasFile: true },
    21: { name: 'Personas', table: 'wb_comp_personas', minSize: 3, requiredFields: ['titulo', 'texto'], hasFile: true },
    23: { name: 'Video', table: 'wb_comp_video', minSize: 3, requiredFields: ['titulo', 'texto', 'url_link', 'f_video'], hasFile: true },
    24: { name: 'Colección fotográfica', table: 'wb_comp_coleccion_fotografica', minSize: 12, requiredFields: ['fk_id_cat_tag'], hasFile: false }
};

/** Placeholder editable cuando el agente crea Redes sociales sin URLs (evita componente “vacío” solo con fondo). */
const REDES_SOCIALES_AGENT_DEFAULTS = {
    facebook: 'Facebook',
    facebook_link: 'https://www.facebook.com/morena.org.mx',
    instagram: 'Instagram',
    instagram_link: 'https://www.instagram.com/morenaorg.mx/',
    tiktok: 'TikTok',
    tiktok_link: 'https://www.tiktok.com/@partidomorena',
    x_twitter: 'X',
    x_twitter_link: 'https://x.com/morenaorginal',
    yt: 'YouTube',
    yt_link: 'https://www.youtube.com/@MorenaOrginal',
};

function hasAnyRedSocialValue(data) {
    if (!data || typeof data !== 'object') return false;
    const keys = ['facebook', 'facebook_link', 'instagram', 'instagram_link', 'tiktok', 'tiktok_link', 'x_twitter', 'x_twitter_link', 'yt', 'yt_link'];
    return keys.some((k) => {
        const v = data[k];
        return v != null && String(v).trim() !== '' && String(v) !== 'null';
    });
}

function ensureRedesSocialesAgentDefaults(data) {
    if (!data || typeof data !== 'object') return;
    if (hasAnyRedSocialValue(data)) return;
    Object.assign(data, REDES_SOCIALES_AGENT_DEFAULTS);
}

// Mapeo de palabras clave a tipos de componentes
// Las palabras más específicas deben ir primero para tener prioridad
const KEYWORD_MAP = {
    // Componentes específicos primero (mayor prioridad)
    'card personas': 21, 'personas card': 21, 'tarjeta personas': 21, 'personas tarjeta': 21,
    'personas': 21, 'people': 21, 'person': 21, 'equipo': 21, 'staff': 21,
    'carrusel': 5, 'carousel': 5, 'slider': 5, 'deslizador': 5,
    'noticias': 8, 'news': 8, 'entradas': 8, 'blog': 8,
    'acordeon': 9, 'acordeón': 9, 'accordion': 9,
    'galeria': 10, 'galería': 10, 'gallery': 10, 'fototeca': 10,
    'linea de tiempo': 14, 'línea de tiempo': 14, 'timeline': 14, 'cronologia': 14, 'cronología': 14,
    'redes sociales': 16, 'social media': 16, 'social': 16, 'redes': 16,
    'regeneracion': 17, 'regeneración': 17,
    'coleccion fotografica': 24, 'colección fotográfica': 24, 'fototeca': 24,
    'flip card': 7, 'card flip': 7, 'tarjeta flip': 7, 'flip': 7,
    'cards regeneracion': 17, 'cards regeneración': 17,
    'cards': 13, 'tarjetas': 13,
    'card': 7, 'tarjeta': 7, // Menor prioridad, solo si no hay contexto más específico
    'titulo': 1, 'título': 1, 'title': 1, 'encabezado': 1,
    'subtitulo': 2, 'subtítulo': 2, 'subtitle': 2,
    'texto': 3, 'text': 3, 'parrafo': 3, 'párrafo': 3, 'contenido': 3,
    'boton': 4, 'botón': 4, 'button': 4, 'btn': 4,
    'imagen': 20, 'image': 20, 'img': 20, 'foto': 20, 'picture': 20,
    'video': 23, 'vídeo': 23
};

// Patrones de entrenamiento - Ejemplos de cómo los usuarios suelen pedir componentes
const TRAINING_PATTERNS = {
    // Patrones para carrusel
    carrusel: [
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?carrusel/i,
        /carrusel\s+con\s+(\d+)\s+slides?/i,
        /slider\s+con\s+(\d+)\s+imágenes?/i,
        /carousel\s+de\s+(\d+)\s+slides?/i
    ],
    // Patrones para personas
    personas: [
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?(?:card|tarjeta)\s+personas/i,
        /personas\s+(?:card|tarjeta)/i,
        /equipo\s+de\s+trabajo/i,
        /tarjeta\s+de\s+personas/i
    ],
    // Patrones para flip card
    flip: [
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?flip\s+card/i,
        /card\s+flip/i,
        /tarjeta\s+reversible/i
    ],
    // Patrones para botón
    boton: [
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?botón/i,
        /botón\s+que\s+diga\s+["']?([^"']+)["']?/i,
        /button/i
    ],
    // Patrones para línea de tiempo
    timeline: [
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?(?:componente\s+de\s+)?(?:linea|línea)\s+(?:del\s+)?tiempo/i,
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?(?:componente\s+)?timeline/i,
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?(?:componente\s+de\s+)?cronologia/i,
        /(?:quiero|crea|crear|agrega|agregar|haz|hacer)\s+(?:un\s+)?(?:componente\s+de\s+)?cronología/i,
        /(?:componente\s+de\s+)?(?:linea|línea)\s+(?:del\s+)?tiempo/i,
        /timeline/i,
        /cronologia|cronología/i
    ]
};

/**
 * Genera un token JWT para cy
 */
function generateCyToken(idapp) {
    return jwt.sign(
        {
            idapp: idapp,
            date_comp: new Date()
        },
        process.env.SECRET
    );
}

/**
 * Genera un token JWT para dataComp
 */
function generateDataCompToken(idapp, tablecomp, id_componente = null) {
    const payload = {
        idapp: idapp,
        date_comp: new Date(),
        tabla: tablecomp
    };
    if (id_componente) {
        payload.id_componente = id_componente;
    }
    return jwt.sign(payload, process.env.SECRET);
}

/**
 * Detecta si el prompt es una confirmación
 */
function isConfirmation(prompt) {
    const confirmations = ['si', 'sí', 'yes', 'ok', 'okay', 'de acuerdo', 'correcto', 'vale', 'perfecto', 'adelante', 'procede', 'crea', 'crear', 'hazlo', 'haz lo'];
    const promptLower = prompt.toLowerCase().trim();
    return confirmations.some(conf => promptLower === conf || promptLower.startsWith(conf + ' ') || promptLower.endsWith(' ' + conf));
}

/**
 * Analiza el prompt del usuario y determina qué componente(s) quiere crear
 */
async function analyzePrompt(userPrompt, pageId, idapp, conversationContext = null) {
    const prompt = userPrompt.toLowerCase().trim();
    const analysis = {
        components: [],
        providedData: {},
        missingData: {},
        errors: [],
        isConfirmation: false,
        contextComponent: null,
        sectionRequest: null, // { numColumns: 1-4, components: [] }
        isOutOfScope: false,
        requestedSectionIndex: null, // 1-based: "sección 2" -> 2
        requestedColumnIndex: null   // 1-based: "columna 1" -> 1
    };

    // Si hay contexto previo, heredar datos
    if (conversationContext && conversationContext.pendingComponent) {
        analysis.contextComponent = conversationContext.pendingComponent;
        analysis.providedData = { ...(conversationContext.providedData || {}) };

        // Si el usuario confirma, usar el contexto directamente
        if (isConfirmation(prompt)) {
            analysis.isConfirmation = true;
            analysis.components = [conversationContext.pendingComponent];

            // IMPORTANTE: Extraer datos que puedan venir en el mismo mensaje de confirmación
            extractDataFromPrompt(prompt, analysis, conversationContext.pendingComponent);
            
            // Si el componente requiere tag y se proporcionó, resolverlo
            if ((conversationContext.pendingComponent.id === 8 || conversationContext.pendingComponent.id === 24) && 
                analysis.providedData.tagName) {
                const tagId = await resolveTagName(analysis.providedData.tagName, conversationContext.pendingComponent.id);
                if (tagId) {
                    analysis.providedData.fk_id_cat_tag = tagId;
                    delete analysis.providedData.tagName;
                }
            }
            
            return analysis;
        }
        
        // Si hay un componente pendiente de regeneración, detectar el año
        if (conversationContext.pendingComponent.id === 17) {
            extractDataFromPrompt(prompt, analysis, conversationContext.pendingComponent);
            
            // Patrones para detectar años
            const yearPatterns = [
                /(?:año|year|anio)[\s:]+(\d{4})/i,
                /(?:del\s+)?(?:año|year|anio)[\s:]+(\d{4})/i,
                /(?:para\s+el\s+)?(?:año|year|anio)[\s:]+(\d{4})/i,
                /\b(20\d{2})\b/ // Cualquier año del 2000-2099
            ];
            
            for (const pattern of yearPatterns) {
                const match = prompt.match(pattern);
                if (match) {
                    const year = parseInt(match[1]);
                    // Validar que sea un año razonable (2018 en adelante, hasta el año actual + 1)
                    const currentYear = new Date().getFullYear();
                    if (year >= 2018 && year <= currentYear + 1) {
                        analysis.providedData.anio_seleccionado = year;
                        analysis.providedData.year_regeneracion = year;
                        analysis.components = [conversationContext.pendingComponent];
                        analysis.skipComponentDetection = true;
                        break;
                    }
                }
            }
        }
        
        // Si hay un componente pendiente de redes sociales, detectar URLs de Facebook e Instagram
        if (conversationContext.pendingComponent.id === 16) {
            extractDataFromPrompt(prompt, analysis, conversationContext.pendingComponent);
            
            // Patrones para detectar URLs de Facebook e Instagram
            // Formato: "de facebook: URL" o "facebook: URL" o "fb: URL"
            const facebookPatterns = [
                /(?:de\s+)?(?:facebook|fb)[\s:]+(https?:\/\/[^\s\n]+)/i,
                /(https?:\/\/[^\s\n]*facebook[^\s\n]*)/i,
                /facebook[\s:]+([^\s\n]+)/i
            ];
            
            const instagramPatterns = [
                /(?:de\s+)?(?:instagram|ig)[\s:]+(https?:\/\/[^\s\n]+)/i,
                /(https?:\/\/[^\s\n]*instagram[^\s\n]*)/i,
                /instagram[\s:]+([^\s\n]+)/i
            ];
            
            // Buscar URL de Facebook
            for (const pattern of facebookPatterns) {
                const match = prompt.match(pattern);
                if (match) {
                    const fbUrl = (match[1] || match[0]).trim();
                    if (fbUrl.startsWith('http://') || fbUrl.startsWith('https://')) {
                        analysis.providedData.facebook = fbUrl;
                        analysis.providedData.facebook_link = fbUrl;
                        break;
                    }
                }
            }
            
            // Buscar URL de Instagram
            for (const pattern of instagramPatterns) {
                const match = prompt.match(pattern);
                if (match) {
                    const igUrl = (match[1] || match[0]).trim();
                    if (igUrl.startsWith('http://') || igUrl.startsWith('https://')) {
                        analysis.providedData.instagram = igUrl;
                        analysis.providedData.instagram_link = igUrl;
                        break;
                    }
                }
            }
            
            // Si se detectaron URLs, mantener el componente del contexto
            if (analysis.providedData.facebook || analysis.providedData.instagram) {
                analysis.components = [conversationContext.pendingComponent];
                analysis.skipComponentDetection = true;
            }
        }
        
        // Si hay un componente pendiente que requiere tag, intentar detectar el tag primero
        // antes de buscar nuevos componentes
        if ((conversationContext.pendingComponent.id === 8 || conversationContext.pendingComponent.id === 24) &&
            !conversationContext.providedData?.fk_id_cat_tag) {
            // Extraer datos primero para ver si hay un tag
            extractDataFromPrompt(prompt, analysis, conversationContext.pendingComponent);
            
            // Si se detectó un tag, resolverlo y mantener el componente del contexto
            if (analysis.providedData.tagName || analysis.providedData.possibleTagName) {
                const tagNameToResolve = analysis.providedData.tagName || analysis.providedData.possibleTagName;
                const tagId = await resolveTagName(tagNameToResolve, conversationContext.pendingComponent.id);
                if (tagId) {
                    analysis.providedData.fk_id_cat_tag = tagId;
                    analysis.providedData.tagName = tagNameToResolve;
                    delete analysis.providedData.possibleTagName;
                    // Mantener el componente del contexto
                    analysis.components = [conversationContext.pendingComponent];
                    // No buscar más componentes, ya tenemos el del contexto
                    // Continuar con validación de campos
                } else {
                    // Si no se resolvió, buscar en las categorías disponibles
                    const availableTags = await getAvailableTags(conversationContext.pendingComponent.id, idapp);
                    const promptLower = prompt.toLowerCase().trim();
                    
                    for (const tag of availableTags) {
                        if (promptLower === tag.name.toLowerCase() || 
                            promptLower.includes(tag.name.toLowerCase()) ||
                            tag.name.toLowerCase().includes(promptLower)) {
                            const resolvedTagId = await resolveTagName(tag.name, conversationContext.pendingComponent.id);
                            if (resolvedTagId) {
                                analysis.providedData.fk_id_cat_tag = resolvedTagId;
                                analysis.providedData.tagName = tag.name;
                                analysis.components = [conversationContext.pendingComponent];
                                break;
                            }
                        }
                    }
                }
            } else {
                // Si no se detectó tag con patrones, buscar directamente en las categorías disponibles
                const availableTags = await getAvailableTags(conversationContext.pendingComponent.id, idapp);
                const promptLower = prompt.toLowerCase().trim();
                
                // Buscar coincidencia exacta
                for (const tag of availableTags) {
                    if (promptLower === tag.name.toLowerCase()) {
                        const tagId = await resolveTagName(tag.name, conversationContext.pendingComponent.id);
                        if (tagId) {
                            analysis.providedData.fk_id_cat_tag = tagId;
                            analysis.providedData.tagName = tag.name;
                            analysis.components = [conversationContext.pendingComponent];
                            break;
                        }
                    }
                }
                
                // Si no hay coincidencia exacta, buscar parcial
                if (!analysis.providedData.fk_id_cat_tag) {
                    for (const tag of availableTags) {
                        if (promptLower.includes(tag.name.toLowerCase()) || 
                            tag.name.toLowerCase().includes(promptLower)) {
                            const tagId = await resolveTagName(tag.name, conversationContext.pendingComponent.id);
                            if (tagId) {
                                analysis.providedData.fk_id_cat_tag = tagId;
                                analysis.providedData.tagName = tag.name;
                                analysis.components = [conversationContext.pendingComponent];
                                break;
                            }
                        }
                    }
                }
            }
            
            // Si se resolvió el tag, mantener el componente del contexto y saltar detección de nuevos componentes
            if (analysis.providedData.fk_id_cat_tag && analysis.components.length > 0) {
                // Ya tenemos el componente y el tag resuelto, saltar detección de nuevos componentes
                // Continuar directamente con validación de campos más abajo
                // Marcar que debemos saltar la detección de componentes
                analysis.skipComponentDetection = true;
            }
        }
    }

    const lowerPrompt = prompt; // Para compatibilidad con restos del código

    // PRIMERO: Detectar si es una solicitud de sección/columna o si está fuera del alcance
    const sectionPatterns = [
        /(?:crea|crear|agrega|agregar|haz|hacer|quiero|necesito|deseo)\s+(?:una\s+)?(?:nueva\s+)?secci[oó]n\s+(?:con\s+)?(\d+)\s+columna/i,
        /(?:crea|crear|agrega|agregar|haz|hacer|quiero|necesito|deseo)\s+(?:una\s+)?(?:nueva\s+)?secci[oó]n\s+(?:de\s+)?(\d+)\s+columna/i,
        /(?:quiero|necesito|deseo)\s+(?:una\s+)?(?:nueva\s+)?secci[oó]n/i,
        /(?:crea|crear|agrega|agregar|haz|hacer)\s+(?:una\s+)?(?:nueva\s+)?secci[oó]n/i,
        /(?:nueva\s+)?secci[oó]n\s+(?:con\s+)?(\d+)\s+columna/i,
        /(?:nueva\s+)?secci[oó]n\s+(?:de\s+)?(\d+)\s+columna/i
    ];

    let sectionMatch = null;
    let numColumns = null;
    for (const pattern of sectionPatterns) {
        sectionMatch = prompt.match(pattern);
        if (sectionMatch) {
            if (sectionMatch[1]) {
                // Se especificó un número de columnas
                numColumns = parseInt(sectionMatch[1]);
                // Validar que el número de columnas esté entre 1 y 4
                if (numColumns >= 1 && numColumns <= 4) {
                    break;
                } else {
                    // Número inválido, ignorar este match
                    sectionMatch = null;
                    continue;
                }
            } else {
                // Solo se mencionó "sección" sin número, usar 1 por defecto
                numColumns = 1;
                break;
            }
        }
    }

    // Si se detectó una solicitud de sección, procesarla
    if (sectionMatch && numColumns >= 1 && numColumns <= 4) {
        analysis.sectionRequest = {
            numColumns: numColumns,
            components: []
        };
        
        // Verificar si también se mencionan componentes en la misma solicitud
        // Buscar palabras clave de componentes en el prompt
        const componentKeywords = [
            /\b(?:carrusel|carousel|slider)\b/i,
            /\b(?:bot[oó]n|button|btn)\b/i,
            /\b(?:texto|text)\b/i,
            /\b(?:t[ií]tulo|title)\b/i,
            /\b(?:imagen|image|img)\b/i,
            /\b(?:video|v[ií]deo)\b/i,
            /\b(?:galer[ií]a|gallery)\b/i,
            /\b(?:noticias|news)\b/i,
            /\b(?:acorde[oó]n|accordion)\b/i,
            /\b(?:card|cards|tarjeta|tarjetas)\b/i,
            /\b(?:personas|people)\b/i,
            /\b(?:flip|flipcard)\b/i,
            /\b(?:componente|componentes|comp)\b/i
        ];
        
        const hasComponentKeyword = componentKeywords.some(pattern => pattern.test(prompt));
        
        // Solo buscar componentes si hay palabras clave de componentes en el prompt
        if (hasComponentKeyword) {
            analysis.skipComponentDetection = false; // Permitir detección de componentes
            // Extraer datos del prompt antes de detectar componentes
            extractDataFromPrompt(prompt, analysis, null);
        } else {
            // No hay componentes mencionados, marcar para saltar la detección
            analysis.skipComponentDetection = true;
        }
    }

    // Detectar sección y columna donde registrar el componente (ej: "en la sección 2 columna 1")
    const ordinalToNumber = { primera: 1, segundo: 2, segunda: 2, tercera: 3, tercer: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5 };
    // Primero: "sección 2 columna 1" o "columna 1 sección 2"
    const secCol = prompt.match(/secci[oó]n\s+(\d+)\s*(?:,|\sy\s)?\s*columna\s+(\d+)/i);
    const colSec = prompt.match(/columna\s+(\d+)\s*(?:,|\sy\s)?\s*secci[oó]n\s+(\d+)/i);
    if (secCol && secCol[1] && secCol[2]) {
        analysis.requestedSectionIndex = Math.max(1, parseInt(secCol[1], 10));
        analysis.requestedColumnIndex = Math.max(1, parseInt(secCol[2], 10));
    } else if (colSec && colSec[1] && colSec[2]) {
        analysis.requestedColumnIndex = Math.max(1, parseInt(colSec[1], 10));
        analysis.requestedSectionIndex = Math.max(1, parseInt(colSec[2], 10));
    } else {
        // Por separado: "en la sección 2", "en la columna 1", "primera sección"
        const secMatch = prompt.match(/(?:en\s+(?:la\s+)?|en\s+)secci[oó]n\s+(\d+)/i) || prompt.match(/(?:la\s+)?(primera|segunda|tercera|cuarta|quinta)\s+secci[oó]n/i) || prompt.match(/\bsecci[oó]n\s+(\d+)\b/i);
        const colMatch = prompt.match(/(?:en\s+(?:la\s+)?|en\s+)columna\s+(\d+)/i) || prompt.match(/(?:la\s+)?(primera|segunda|tercera|cuarta|quinta)\s+columna/i) || prompt.match(/\bcolumna\s+(\d+)\b/i);
        if (secMatch && secMatch[1]) {
            const n = ordinalToNumber[secMatch[1].toLowerCase()] || parseInt(secMatch[1], 10);
            if (n >= 1 && n <= 50) analysis.requestedSectionIndex = n;
        }
        if (colMatch && colMatch[1]) {
            const n = ordinalToNumber[colMatch[1].toLowerCase()] || parseInt(colMatch[1], 10);
            if (n >= 1 && n <= 50) analysis.requestedColumnIndex = n;
        }
    }

    // Validar si la solicitud está fuera del alcance
    // El agente solo puede ayudar con: componentes, secciones y columnas
    const outOfScopeKeywords = [
        /\b(?:p[aá]gina|page|p[aá]ginas)\b/i,
        /\b(?:usuario|user|usuarios)\b/i,
        /\b(?:configuraci[oó]n|config|settings)\b/i,
        /\b(?:base\s+de\s+datos|database|db)\b/i,
        /\b(?:archivo|file|files|archivos)\b/i,
        /\b(?:sistema|system)\b/i
    ];

    // Solo marcar como fuera del alcance si NO menciona componentes, secciones o columnas
    const inScopeKeywords = [
        /\b(?:componente|componentes|comp)\b/i,
        /\b(?:secci[oó]n|secciones|sec)\b/i,
        /\b(?:columna|columnas|col)\b/i,
        /\b(?:carrusel|carousel|slider)\b/i,
        /\b(?:bot[oó]n|button|btn)\b/i,
        /\b(?:texto|text)\b/i,
        /\b(?:t[ií]tulo|title)\b/i,
        /\b(?:imagen|image|img)\b/i,
        /\b(?:video|v[ií]deo)\b/i,
        /\b(?:galer[ií]a|gallery)\b/i,
        /\b(?:noticias|news)\b/i,
        /\b(?:acorde[oó]n|accordion)\b/i,
        /\b(?:card|cards|tarjeta|tarjetas)\b/i,
        /\b(?:personas|people)\b/i,
        /\b(?:flip|flipcard)\b/i,
        /\b(?:linea|línea)\s+(?:del\s+)?tiempo\b/i,
        /\b(?:timeline|cronologia|cronología)\b/i
    ];

    const hasInScopeKeyword = inScopeKeywords.some(pattern => pattern.test(prompt));
    const hasOutOfScopeKeyword = outOfScopeKeywords.some(pattern => pattern.test(prompt));

    // Si tiene palabras fuera del alcance Y no tiene palabras dentro del alcance, marcar como fuera del alcance
    if (hasOutOfScopeKeyword && !hasInScopeKeyword && !sectionMatch) {
        // Verificar si es una solicitud explícita fuera del alcance
        const explicitOutOfScope = [
            /(?:crea|crear|modifica|modificar|elimina|eliminar|borra|borrar)\s+(?:una\s+)?(?:p[aá]gina|page)/i,
            /(?:crea|crear|modifica|modificar|elimina|eliminar|borra|borrar)\s+(?:un\s+)?(?:usuario|user)/i,
            /(?:configura|configurar|ajusta|ajustar)\s+(?:el\s+)?(?:sistema|system)/i
        ];
        
        if (explicitOutOfScope.some(pattern => pattern.test(prompt))) {
            analysis.isOutOfScope = true;
            analysis.errors.push('Lo siento, solo puedo ayudarte con la creación de componentes, secciones y columnas. No puedo ayudarte con páginas, usuarios, configuraciones del sistema u otras funcionalidades fuera de este alcance.');
            return analysis;
        }
    }

    // Solo detectar nuevos componentes si no hay un componente del contexto con tag resuelto
    if (!analysis.skipComponentDetection) {
        // Detectar componentes mencionados usando patrones de entrenamiento
        // Buscar primero frases completas (más específicas), luego palabras individuales
        const foundComponents = new Map(); // Para evitar duplicados y priorizar

        // Usar patrones de entrenamiento para detectar componentes
        for (const [patternType, patterns] of Object.entries(TRAINING_PATTERNS)) {
        for (const pattern of patterns) {
            const match = prompt.match(pattern);
            if (match) {
                if (patternType === 'carrusel') {
                    foundComponents.set(5, 'carrusel');
                    if (match[1]) {
                        analysis.providedData.numSlides = parseInt(match[1]);
                    }
                } else if (patternType === 'personas') {
                    foundComponents.set(21, 'personas');
                } else if (patternType === 'flip') {
                    foundComponents.set(7, 'flip card');
                } else if (patternType === 'boton') {
                    foundComponents.set(4, 'botón');
                    if (match[1]) {
                        analysis.providedData.texto = match[1].trim();
                    }
                } else if (patternType === 'timeline') {
                    foundComponents.set(14, 'línea de tiempo');
                    if (match[1]) {
                        analysis.providedData.numSlides = parseInt(match[1]);
                    }
                }
                break;
            }
        }
        }

        // Prioridad especial: si aparece "personas" junto con "card", priorizar personas
        const hasPersonas = /\b(personas|people|person|equipo|staff)\b/i.test(prompt);
        const hasCard = /\b(card|cards|tarjeta|tarjetas)\b/i.test(prompt);

        if (hasPersonas && hasCard && !foundComponents.has(21)) {
            // Si aparecen ambas, priorizar personas sobre card
            foundComponents.set(21, 'personas');
        }

        // Primero buscar frases completas (más específicas)
        const phrases = Object.keys(KEYWORD_MAP).filter(k => k.includes(' ') || k.length > 6);
        for (const keyword of phrases) {
            // Buscar la palabra clave directamente o con "componente de" antes
            const keywordPattern = new RegExp(`(?:componente\\s+de\\s+)?${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
            if (keywordPattern.test(prompt)) {
                const compId = KEYWORD_MAP[keyword];
                if (!foundComponents.has(compId)) {
                    foundComponents.set(compId, keyword);
                }
            }
        }

        // Luego buscar palabras individuales (menos específicas)
        // Ordenar por especificidad: palabras más largas primero
        const sortedKeywords = Object.entries(KEYWORD_MAP).sort((a, b) => {
            // Priorizar palabras más largas
            if (b[0].length !== a[0].length) {
                return b[0].length - a[0].length;
            }
            // Si tienen la misma longitud, mantener orden original
            return 0;
        });

        for (const [keyword, compId] of sortedKeywords) {
            // Solo si no es una frase y no se encontró ya un componente más específico
            if (!keyword.includes(' ') && !foundComponents.has(compId)) {
                // Verificar que la palabra esté como palabra completa, no como parte de otra
                const wordRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                if (wordRegex.test(prompt)) {
                    // Si ya tenemos "personas" y encontramos "card", ignorar card
                    if (compId === 7 && foundComponents.has(21)) {
                        continue;
                    }
                    foundComponents.set(compId, keyword);
                }
            }
        }

        // Procesar componentes encontrados
        for (const [compId, keyword] of foundComponents) {
            const config = COMPONENT_CONFIG[compId];
            if (config) {
                // Verificar si ya existe un acordeón en la página
                if (compId === 9) {
                    const hasAccordion = await checkAccordionExists(pageId);
                    if (hasAccordion) {
                        analysis.errors.push('Solo puede haber un componente acordeón por página.');
                        continue;
                    }
                }

                const component = {
                    id: compId,
                    name: config.name,
                    table: config.table,
                    minSize: config.minSize,
                    requiredFields: config.requiredFields,
                    hasFile: config.hasFile,
                    hasSlides: config.hasSlides || false,
                    special: config.special || false,
                    matchedKeyword: keyword
                };
                
                analysis.components.push(component);
                
                // Si es componente de regeneración, extraer el año del prompt si está presente
                if (compId === 17) {
                    extractDataFromPrompt(prompt, analysis, component);
                    
                    // Patrones para detectar años en el prompt inicial
                    const yearPatterns = [
                        /(?:año|year|anio)[\s:]+(\d{4})/i,
                        /(?:del\s+)?(?:año|year|anio)[\s:]+(\d{4})/i,
                        /(?:para\s+el\s+)?(?:año|year|anio)[\s:]+(\d{4})/i,
                        /\b(20\d{2})\b/ // Cualquier año del 2000-2099
                    ];
                    
                    for (const pattern of yearPatterns) {
                        const match = prompt.match(pattern);
                        if (match) {
                            const year = parseInt(match[1]);
                            // Validar que sea un año razonable (2018 en adelante, hasta el año actual + 1)
                            const currentYear = new Date().getFullYear();
                            if (year >= 2018 && year <= currentYear + 1) {
                                analysis.providedData.anio_seleccionado = year;
                                analysis.providedData.year_regeneracion = year;
                                analysis.providedData.anio = year;
                                break;
                            }
                        }
                    }
                } else if (compId === 16) {
                    // Misma extracción de URLs que con contexto pendiente (primera petición “agrega redes…”).
                    extractDataFromPrompt(prompt, analysis, component);
                }
            }
        }

        // Si no se detectó ningún componente, intentar inferir del contexto de manera más inteligente
        if (analysis.components.length === 0) {
            // Detectar carrusel por contexto de slides/imágenes
            const slideMatch = prompt.match(/(\d+)\s*(slide|slides|imagen|imágenes|diapositiva)/i);
            if (slideMatch) {
                analysis.components.push({
                    id: 5,
                    name: 'Carrusel',
                    table: 'wb_comp_carrousel',
                    minSize: 12,
                    requiredFields: ['titulo_slides', 'text_slides', 'text_btn_slides', 'url_slides'],
                    hasFile: true,
                    hasSlides: true
                });
            }

            // Detectar por palabras clave de acción
            if (lowerPrompt.includes('mostrar') || lowerPrompt.includes('mostrar') || lowerPrompt.includes('exhibir')) {
                if (lowerPrompt.includes('imagen') || lowerPrompt.includes('foto')) {
                    analysis.components.push({
                        id: 10,
                        name: 'Galería',
                        table: 'wb_comp_galeria',
                        minSize: 12,
                        requiredFields: ['titulo_slides', 'text_slides'],
                        hasFile: true,
                        hasSlides: true
                    });
                }
            }

            // Detectar botón simple
            if ((lowerPrompt.includes('botón') || lowerPrompt.includes('boton') || lowerPrompt.includes('button')) &&
                !lowerPrompt.includes('card') && !lowerPrompt.includes('flip')) {
                analysis.components.push({
                    id: 4,
                    name: 'Botón',
                    table: 'wb_comp_boton',
                    minSize: 3,
                    requiredFields: ['texto', 'liga'],
                    hasFile: false
                });
            }

            // Detectar texto simple - Solo si no hay un componente pendiente en contexto
            // o si el prompt es explícitamente "crea un texto"
            const isExplicitText = /crea(?:r)?\s+(?:un\s+)?texto/i.test(prompt);
            if ((isExplicitText || (lowerPrompt.includes('texto') || lowerPrompt.includes('text') || lowerPrompt.includes('párrafo') || lowerPrompt.includes('parrafo'))) &&
                !lowerPrompt.includes('titulo') && !lowerPrompt.includes('subtitulo') &&
                (!analysis.contextComponent || isExplicitText)) {

                // Verificar que no sea solo una asignación de datos (ej: "el texto es...")
                const isDataAssignment = AGENT_KNOWLEDGE.dataPatterns.texto.some(p => p.test(prompt));

                if (!isDataAssignment || isExplicitText) {
                    analysis.components.push({
                        id: 3,
                        name: 'Texto',
                        table: 'wb_comp_texto',
                        minSize: 3,
                        requiredFields: ['texto'],
                        hasFile: false
                    });
                }
            }
        }
    } // Fin del bloque condicional de detección de componentes

    // Extraer datos proporcionados del prompt
    // Si hay un componente pendiente que requiere tag, pasar esa información para mejor detección
    const pendingComponentForTag = conversationContext?.pendingComponent;
    extractDataFromPrompt(prompt, analysis, pendingComponentForTag);

    // Resolver tags si se proporcionó un nombre de tag
    for (const component of analysis.components) {
        if ((component.id === 8 || component.id === 24) && analysis.providedData.tagName) {
            const tagId = await resolveTagName(analysis.providedData.tagName, component.id);
            if (tagId) {
                analysis.providedData.fk_id_cat_tag = tagId;
                delete analysis.providedData.tagName; // Limpiar el nombre temporal
            }
        }
    }

    // Si hay contexto previo con componente que requiere tag y el usuario solo proporcionó el nombre del tag
    if (conversationContext?.pendingComponent && 
        (conversationContext.pendingComponent.id === 8 || conversationContext.pendingComponent.id === 24) &&
        !analysis.providedData.fk_id_cat_tag && 
        !analysis.providedData.tagName) {
        
        // Intentar detectar si el prompt es solo el nombre de una categoría
        const availableTags = await getAvailableTags(conversationContext.pendingComponent.id, idapp);
        const promptLower = prompt.toLowerCase().trim();
        
        // Buscar coincidencia exacta primero
        for (const tag of availableTags) {
            if (promptLower === tag.name.toLowerCase()) {
                const tagId = await resolveTagName(tag.name, conversationContext.pendingComponent.id);
                if (tagId) {
                    analysis.providedData.fk_id_cat_tag = tagId;
                    analysis.providedData.tagName = tag.name;
                    break;
                }
            }
        }
        
        // Si no hay coincidencia exacta, buscar coincidencia parcial
        if (!analysis.providedData.fk_id_cat_tag) {
            for (const tag of availableTags) {
                // Coincidencia parcial: el prompt contiene el nombre del tag o viceversa
                if (promptLower.includes(tag.name.toLowerCase()) || 
                    tag.name.toLowerCase().includes(promptLower)) {
                    const tagId = await resolveTagName(tag.name, conversationContext.pendingComponent.id);
                    if (tagId) {
                        analysis.providedData.fk_id_cat_tag = tagId;
                        analysis.providedData.tagName = tag.name;
                        break;
                    }
                }
            }
        }
    }

    // También procesar possibleTagName si existe
    if (analysis.providedData.possibleTagName && !analysis.providedData.fk_id_cat_tag && !analysis.providedData.tagName) {
        for (const component of analysis.components) {
            if (component.id === 8 || component.id === 24) {
                const tagId = await resolveTagName(analysis.providedData.possibleTagName, component.id);
                if (tagId) {
                    analysis.providedData.fk_id_cat_tag = tagId;
                    analysis.providedData.tagName = analysis.providedData.possibleTagName;
                    delete analysis.providedData.possibleTagName;
                    break;
                }
            }
        }
    }

    // Si hay una solicitud de sección con componentes, actualizar el sectionRequest
    if (analysis.sectionRequest && analysis.components.length > 0) {
        analysis.sectionRequest.components = analysis.components;
    }

    // Si tenemos un componente en contexto y no se detectó nada nuevo de forma explícita,
    // mantener el componente del contexto como principal.
    if (analysis.contextComponent && analysis.components.length === 0) {
        analysis.components = [analysis.contextComponent];
    } else if (analysis.contextComponent && analysis.components.length > 0) {
        // Si se detectaron componentes que coinciden con nombres de campos del componente actual,
        // eliminarlos del listado de "nuevos componentes" para evitar duplicados.
        analysis.components = analysis.components.filter(comp => {
            // No crear Título (1), Subtítulo (2), Texto (3), Imagen (20) o Botón (4)
            // si parecen ser solo campos del componente actual, a menos que se pida explícitamente "crear"
            const fieldNames = ['titulo', 'subtitulo', 'texto', 'imagen', 'botón', 'boton', 'link', 'enlace'];
            const lowerName = comp.name.toLowerCase();
            const isFieldName = fieldNames.some(f => lowerName.includes(f));
            const isExplicitCreate = /crea(?:r)?/i.test(prompt) && prompt.includes(lowerName);

            if (isFieldName && !isExplicitCreate) return false;
            return true;
        });

        // Si después del filtro nos quedamos sin componentes, restaurar el del contexto
        if (analysis.components.length === 0) {
            analysis.components = [analysis.contextComponent];
        }
    }
    // Validar datos faltantes de manera más inteligente
    for (const component of analysis.components) {
        const missing = [];

        // Mapear campos requeridos según el tipo de componente
        let requiredFieldsToCheck = [...component.requiredFields];

        // Para componentes con slides, mapear campos genéricos a campos de slides
        if (component.hasSlides) {
            // Si tiene datos genéricos, considerarlos como datos de slides
            if (analysis.providedData.titulo && !analysis.providedData.titulo_slides_1) {
                analysis.providedData.titulo_slides_1 = analysis.providedData.titulo;
            }
            if (analysis.providedData.texto && !analysis.providedData.text_slides_1) {
                analysis.providedData.text_slides_1 = analysis.providedData.texto;
            }
            if (analysis.providedData.url_link && !analysis.providedData.url_slides_1) {
                analysis.providedData.url_slides_1 = analysis.providedData.url_link;
            }
            if (analysis.providedData.liga && !analysis.providedData.url_slides_1) {
                analysis.providedData.url_slides_1 = analysis.providedData.liga;
            }

            // Para carrusel, el botón puede tener valor por defecto
            if (component.id === 5 && !analysis.providedData.btn_text_slides_1 && !analysis.providedData.text_btn_slides_1) {
                // No marcar como faltante, se asignará por defecto
            }
        }

        // Verificar campos requeridos
        for (const field of requiredFieldsToCheck) {
            // Verificar si el campo existe en providedData
            const hasField = analysis.providedData[field] !== undefined &&
                analysis.providedData[field] !== null &&
                analysis.providedData[field] !== '';

            // Para campos de slides, verificar también la versión genérica
            let hasFieldGeneric = false;
            if (field.includes('slides')) {
                const genericField = field.replace('_slides_1', '').replace('slides_1', '');
                hasFieldGeneric = analysis.providedData[genericField] !== undefined &&
                    analysis.providedData[genericField] !== null &&
                    analysis.providedData[genericField] !== '';
            }

            // Para regeneración, verificar si hay año proporcionado
            if (component.id === 17) {
                if ((field === 'anio_seleccionado' || field === 'year_regeneracion') && !hasField) {
                    const hasYear = analysis.providedData.anio_seleccionado || analysis.providedData.year_regeneracion || analysis.providedData.anio;
                    if (hasYear) {
                        // Si hay un año, mapearlo a ambos campos
                        const year = analysis.providedData.anio_seleccionado || analysis.providedData.year_regeneracion || analysis.providedData.anio;
                        analysis.providedData.anio_seleccionado = year;
                        analysis.providedData.year_regeneracion = year;
                        continue; // Ya está proporcionado
                    }
                }
            }
            
            // Para redes sociales, verificar si hay URLs proporcionadas
            if (component.id === 16) {
                // Para facebook y facebook_link, verificar si hay alguna URL de Facebook
                if ((field === 'facebook' || field === 'facebook_link') && !hasField) {
                    const hasFacebookUrl = analysis.providedData.facebook || analysis.providedData.facebook_link;
                    if (hasFacebookUrl) {
                        // Si hay una URL de Facebook, mapearla a ambos campos
                        const fbUrl = analysis.providedData.facebook || analysis.providedData.facebook_link;
                        analysis.providedData.facebook = fbUrl;
                        analysis.providedData.facebook_link = fbUrl;
                        continue; // Ya está proporcionado
                    }
                }
                
                // Para instagram y instagram_link, verificar si hay alguna URL de Instagram
                if ((field === 'instagram' || field === 'instagram_link') && !hasField) {
                    const hasInstagramUrl = analysis.providedData.instagram || analysis.providedData.instagram_link;
                    if (hasInstagramUrl) {
                        // Si hay una URL de Instagram, mapearla a ambos campos
                        const igUrl = analysis.providedData.instagram || analysis.providedData.instagram_link;
                        analysis.providedData.instagram = igUrl;
                        analysis.providedData.instagram_link = igUrl;
                        continue; // Ya está proporcionado
                    }
                }
            }
            
            // Para fk_id_cat_tag, verificar también si hay tagName en el contexto previo o si ya se resolvió
            if (field === 'fk_id_cat_tag') {
                // Si ya tiene un ID numérico, está resuelto
                if (typeof analysis.providedData.fk_id_cat_tag === 'number') {
                    continue; // Ya está resuelto, no marcar como faltante
                }
                
                // Si hay tagName pero aún no se resolvió, intentar resolverlo ahora
                if (analysis.providedData.tagName && !hasField) {
                    const tagId = await resolveTagName(analysis.providedData.tagName, component.id);
                    if (tagId) {
                        analysis.providedData.fk_id_cat_tag = tagId;
                        delete analysis.providedData.tagName;
                        continue; // Ya está resuelto
                    }
                }
                
                // Verificar contexto previo
                if (!hasField && conversationContext && conversationContext.providedData) {
                    const contextTag = conversationContext.providedData.fk_id_cat_tag || conversationContext.providedData.tagName;
                    if (contextTag) {
                        // Si es un número, ya está resuelto
                        if (typeof contextTag === 'number') {
                            analysis.providedData.fk_id_cat_tag = contextTag;
                            continue;
                        }
                        // Si es un string, intentar resolverlo
                        if (typeof contextTag === 'string') {
                            const tagId = await resolveTagName(contextTag, component.id);
                            if (tagId) {
                                analysis.providedData.fk_id_cat_tag = tagId;
                                continue;
                            }
                        }
                    }
                }
            }

            if (!hasField && !hasFieldGeneric) {
                // Si el campo puede tener un valor por defecto institucional, no bloquear
                const defaultableFields = ['titulo', 'texto', 'url_link', 'liga', 'f_video', 'btn_text_slides_1', 'text_btn_slides_1', 'url_slides_1', 'anio_slides_1', 'titulo_slides_1', 'text_slides_1', 'orden_visible_slides_1'];
                
                // Para regeneración, anio_seleccionado es obligatorio - debe pedirse si no está presente
                if (component.id === 17 && (field === 'anio_seleccionado' || field === 'year_regeneracion')) {
                    // Verificar si hay año en los datos proporcionados
                    const hasYear = analysis.providedData.anio_seleccionado || analysis.providedData.year_regeneracion || analysis.providedData.anio;
                    if (!hasYear) {
                        // Marcar como faltante para que se pida
                        missing.push(field);
                        continue;
                    }
                }
                
                // Para redes sociales, los campos no son obligatorios (el usuario puede especificar solo las que quiere)
                const socialMediaFields = ['facebook', 'facebook_link', 'instagram', 'instagram_link', 'tiktok', 'tiktok_link', 'x_twitter', 'x_twitter_link', 'yt', 'yt_link'];
                if (component.id === 16 && socialMediaFields.includes(field)) {
                    // No marcar como faltante, el usuario puede especificar solo las redes que quiere
                    continue;
                }
                
                if (!defaultableFields.includes(field)) {
                    missing.push(field);
                }
            }
        }

        // Forzar skipFile ya que tenemos imágenes por defecto
        analysis.providedData.skipFile = true;
        analysis.providedData.hasFile = true;

        // Para redes sociales, si se proporcionó al menos una red, está listo para crear
        if (component.id === 16) {
            const hasAnySocialNetwork = analysis.providedData.facebook || 
                                       analysis.providedData.instagram || 
                                       analysis.providedData.tiktok || 
                                       analysis.providedData.x_twitter || 
                                       analysis.providedData.yt;
            if (hasAnySocialNetwork) {
                // Tiene al menos una red social, está listo para crear
                analysis.providedData.readyToCreate = true;
                // Limpiar campos de redes sociales de missing si están ahí
                missing = missing.filter(f => !['facebook', 'facebook_link', 'instagram', 'instagram_link', 'tiktok', 'tiktok_link', 'x_twitter', 'x_twitter_link', 'yt', 'yt_link'].includes(f));
            }
        }

        if (missing.length > 0) {
            analysis.missingData[component.id] = missing;
        } else {
            // Si lo que falta es "defaultable", o no falta nada, marcar como listo
            analysis.providedData.readyToCreate = true;
        }
    }

    return analysis;
}

/**
 * Base de conocimiento del agente - Patrones de reconocimiento mejorados
 */
const AGENT_KNOWLEDGE = {
    // Patrones para detectar componentes con contexto
    componentPatterns: {
        'carrusel': {
            keywords: ['carrusel', 'carousel', 'slider', 'deslizador'],
            context: ['slide', 'slides', 'diapositiva', 'imagen', 'foto'],
            examples: ['carrusel con 3 slides', 'carousel de imágenes', 'slider con fotos']
        },
        'personas': {
            keywords: ['persona', 'personas', 'people', 'equipo', 'staff', 'miembros'],
            context: ['card', 'tarjeta', 'perfil', 'biografía'],
            examples: ['card personas', 'tarjeta de personas', 'equipo de trabajo']
        },
        'flip': {
            keywords: ['flip', 'voltear', 'reversible'],
            context: ['card', 'tarjeta'],
            examples: ['flip card', 'tarjeta flip', 'card reversible']
        }
    },

    // Patrones para extraer datos
    dataPatterns: {
        titulo: [
            /(?:titulo|título|title|encabezado|heading)\s*:?\s*["']?([^"'\n\.]+)["']?/i,
            /con\s+el\s+titulo\s+["']?([^"'\n\.]+)["']?/i,
            /titulado\s+["']?([^"'\n\.]+)["']?/i
        ],
        texto: [
            /(?:texto|text|contenido|descripción|descripcion)\s*:?\s*["']?([^"'\n\.]+)["']?/i,
            /que\s+diga\s+["']?([^"'\n\.]+)["']?/i,
            /con\s+el\s+texto\s+["']?([^"'\n\.]+)["']?/i
        ],
        url: [
            /(?:url|link|liga|enlace|dirección|direccion)\s*:?\s*([^\s\n]+)/i,
            /que\s+lleva\s+a\s+([^\s\n]+)/i,
            /enlace\s+a\s+([^\s\n]+)/i,
            /(?:https?:\/\/[^\s]+)/i
        ],
        slides: [
            /(\d+)\s*(?:slide|slides|diapositiva|diapositivas|imagen|imágenes)/i,
            /con\s+(\d+)\s*(?:slide|slides|diapositiva)/i
        ]
    }
};

/**
 * Obtiene las categorías/tags disponibles según el tipo de componente
 */
async function getAvailableTags(componentId, idapp) {
    try {
        if (componentId === 8) {
            // Noticias - tipo tag 2 (entradas)
            const tags = await paginaModel.cat_tags.findAll({
                where: {
                    fk_id_cat_type_tag: 2, // entradas
                    vigente: true,
                },
                order: [['tag', 'ASC']],
                attributes: ['id_cat_tag', 'tag', 'descripcion_tag']
            });
            return tags.map(t => ({ id: t.id_cat_tag, name: t.tag, description: t.descripcion_tag }));
        } else if (componentId === 24) {
            // Colección fotográfica - tipo tag 3 (imágenes)
            const tags = await paginaModel.cat_tags.findAll({
                where: {
                    fk_id_cat_type_tag: 3, // imágenes
                    vigente: true,
                },
                order: [['tag', 'ASC']],
                attributes: ['id_cat_tag', 'tag', 'descripcion_tag']
            });
            return tags.map(t => ({ id: t.id_cat_tag, name: t.tag, description: t.descripcion_tag }));
        }
        return [];
    } catch (error) {
        console.error('Error getting tags:', error);
        return [];
    }
}

/**
 * Resuelve un nombre de tag a su ID en la base de datos
 */
async function resolveTagName(tagName, componentId) {
    try {
        if (!tagName) return null;

        // Determinar el tipo de tag según el componente
        let typeTag = null;
        if (componentId === 8) {
            typeTag = 2; // entradas
        } else if (componentId === 24) {
            typeTag = 3; // imágenes
        } else {
            return null;
        }

        // Buscar el tag por nombre (case-insensitive)
        const tag = await paginaModel.cat_tags.findOne({
            where: {
                tag: { [Op.iLike]: tagName.trim() },
                fk_id_cat_type_tag: typeTag,
                vigente: true
            },
            attributes: ['id_cat_tag', 'tag']
        });

        if (tag) {
            return tag.id_cat_tag;
        }

        return null;
    } catch (error) {
        console.error('Error resolving tag name:', error);
        return null;
    }
}

/**
 * Extrae datos del prompt del usuario de manera más inteligente
 */
function extractDataFromPrompt(prompt, analysis, pendingComponentForTag = null) {
    const lowerPrompt = prompt.toLowerCase();

    // Extraer títulos con múltiples patrones
    for (const pattern of AGENT_KNOWLEDGE.dataPatterns.titulo) {
        const match = prompt.match(pattern);
        if (match && match[1]) {
            analysis.providedData.titulo = match[1].trim();
            break;
        }
    }

    // Si no se encontró título pero hay contexto, inferir
    if (!analysis.providedData.titulo) {
        // Si menciona un componente específico, usar nombre genérico
        if (lowerPrompt.includes('carrusel')) {
            analysis.providedData.titulo = 'Carrusel';
        } else if (lowerPrompt.includes('persona')) {
            analysis.providedData.titulo = 'Persona';
        } else if (lowerPrompt.includes('flip')) {
            analysis.providedData.titulo = 'Flip Card';
        }
    }

    // Extraer textos con múltiples patrones
    for (const pattern of AGENT_KNOWLEDGE.dataPatterns.texto) {
        const match = prompt.match(pattern);
        if (match && match[1]) {
            analysis.providedData.texto = match[1].trim();
            break;
        }
    }

    // Extraer URLs con múltiples patrones
    for (const pattern of AGENT_KNOWLEDGE.dataPatterns.url) {
        const match = prompt.match(pattern);
        if (match && match[1]) {
            const url = match[1].trim();
            // Validar que sea una URL válida
            if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/') || url.startsWith('#')) {
                analysis.providedData.liga = url;
                analysis.providedData.url_link = url;
                break;
            }
        }
    }

    // Buscar URLs directamente en el texto
    const urlDirectMatch = prompt.match(/(https?:\/\/[^\s]+)/i);
    if (urlDirectMatch && !analysis.providedData.url_link) {
        analysis.providedData.liga = urlDirectMatch[1];
        analysis.providedData.url_link = urlDirectMatch[1];
    }
    
    // Redes sociales: extraer URLs (pendiente en conversación o componente ya detectado en esta petición)
    if (pendingComponentForTag && pendingComponentForTag.id === 16) {
        // Mapeo de redes sociales y sus patrones de detección
        const socialNetworks = {
            facebook: {
                patterns: [
                    /(?:de\s+)?(?:facebook|fb)[\s:]+(https?:\/\/[^\s\n]+)/i,
                    /(https?:\/\/[^\s\n]*facebook[^\s\n]*)/i,
                    /facebook[\s:]+([^\s\n]+)/i
                ],
                fields: ['facebook', 'facebook_link']
            },
            instagram: {
                patterns: [
                    /(?:de\s+)?(?:instagram|ig)[\s:]+(https?:\/\/[^\s\n]+)/i,
                    /(https?:\/\/[^\s\n]*instagram[^\s\n]*)/i,
                    /instagram[\s:]+([^\s\n]+)/i
                ],
                fields: ['instagram', 'instagram_link']
            },
            tiktok: {
                patterns: [
                    /(?:de\s+)?(?:tiktok|tt)[\s:]+(https?:\/\/[^\s\n]+)/i,
                    /(https?:\/\/[^\s\n]*tiktok[^\s\n]*)/i,
                    /tiktok[\s:]+([^\s\n]+)/i
                ],
                fields: ['tiktok', 'tiktok_link']
            },
            twitter: {
                patterns: [
                    /(?:de\s+)?(?:twitter|x|tw)[\s:]+(https?:\/\/[^\s\n]+)/i,
                    /(https?:\/\/[^\s\n]*(?:twitter|x\.com)[^\s\n]*)/i,
                    /(?:twitter|x)[\s:]+([^\s\n]+)/i
                ],
                fields: ['x_twitter', 'x_twitter_link']
            },
            youtube: {
                patterns: [
                    /(?:de\s+)?(?:youtube|yt)[\s:]+(https?:\/\/[^\s\n]+)/i,
                    /(https?:\/\/[^\s\n]*(?:youtube|youtu\.be)[^\s\n]*)/i,
                    /(?:youtube|yt)[\s:]+([^\s\n]+)/i
                ],
                fields: ['yt', 'yt_link']
            }
        };
        
        // Detectar URLs para cada red social
        for (const [networkName, networkConfig] of Object.entries(socialNetworks)) {
            for (const pattern of networkConfig.patterns) {
                const match = prompt.match(pattern);
                if (match) {
                    const url = (match[1] || match[0]).trim();
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        // Mapear a ambos campos (nombre y link)
                        analysis.providedData[networkConfig.fields[0]] = url;
                        analysis.providedData[networkConfig.fields[1]] = url;
                        break;
                    }
                }
            }
        }
        
        // Si no se encontraron con patrones específicos, buscar todas las URLs y clasificarlas por dominio
        const allUrls = prompt.matchAll(/(https?:\/\/[^\s\n]+)/gi);
        for (const urlMatch of allUrls) {
            const url = urlMatch[0].trim().toLowerCase();
            if (url.includes('facebook') && !analysis.providedData.facebook) {
                analysis.providedData.facebook = urlMatch[0].trim();
                analysis.providedData.facebook_link = urlMatch[0].trim();
            } else if (url.includes('instagram') && !analysis.providedData.instagram) {
                analysis.providedData.instagram = urlMatch[0].trim();
                analysis.providedData.instagram_link = urlMatch[0].trim();
            } else if (url.includes('tiktok') && !analysis.providedData.tiktok) {
                analysis.providedData.tiktok = urlMatch[0].trim();
                analysis.providedData.tiktok_link = urlMatch[0].trim();
            } else if ((url.includes('twitter') || url.includes('x.com')) && !analysis.providedData.x_twitter) {
                analysis.providedData.x_twitter = urlMatch[0].trim();
                analysis.providedData.x_twitter_link = urlMatch[0].trim();
            } else if ((url.includes('youtube') || url.includes('youtu.be')) && !analysis.providedData.yt) {
                analysis.providedData.yt = urlMatch[0].trim();
                analysis.providedData.yt_link = urlMatch[0].trim();
            }
        }
    }

    // Extraer cantidad de slides con múltiples patrones
    for (const pattern of AGENT_KNOWLEDGE.dataPatterns.slides) {
        const match = prompt.match(pattern);
        if (match && match[1]) {
            analysis.providedData.numSlides = parseInt(match[1]);
            break;
        }
    }

    // Si menciona slides pero no cantidad, inferir
    if (!analysis.providedData.numSlides && (lowerPrompt.includes('slide') || lowerPrompt.includes('diapositiva'))) {
        // Buscar números cercanos a "slide"
        const numMatch = prompt.match(/(\d+)/);
        if (numMatch) {
            analysis.providedData.numSlides = parseInt(numMatch[1]);
        } else {
            analysis.providedData.numSlides = 1; // Por defecto 1 slide
        }
    }

    // Detectar si menciona imágenes de múltiples formas
    const imageKeywords = ['imagen', 'imágenes', 'foto', 'fotos', 'picture', 'pictures', 'img', 'imgs'];
    if (imageKeywords.some(keyword => lowerPrompt.includes(keyword))) {
        analysis.providedData.hasFile = true;

        // Intentar extraer cantidad de imágenes
        const imgCountMatch = prompt.match(/(\d+)\s*(?:imagen|imágenes|foto|fotos)/i);
        if (imgCountMatch) {
            analysis.providedData.numImages = parseInt(imgCountMatch[1]);
        }
    }

    // Detectar años (para línea de tiempo y regeneración)
    const yearMatch = prompt.match(/\b(20\d{2})\b/);
    if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        analysis.providedData.anio = year;
        analysis.providedData.anio_slides_1 = year;
        
        // Si hay un componente pendiente de regeneración, también asignar el año
        if (pendingComponentForTag && pendingComponentForTag.id === 17) {
            analysis.providedData.anio_seleccionado = year;
            analysis.providedData.year_regeneracion = year;
        }
    }
    
    // Detectar años con patrones más específicos para regeneración
    if (pendingComponentForTag && pendingComponentForTag.id === 17) {
        const regeneracionYearPatterns = [
            /(?:año|year|anio)[\s:]+(\d{4})/i,
            /(?:del\s+)?(?:año|year|anio)[\s:]+(\d{4})/i,
            /(?:para\s+el\s+)?(?:año|year|anio)[\s:]+(\d{4})/i,
            /\b(20\d{2})\b/ // Cualquier año del 2000-2099
        ];
        
        for (const pattern of regeneracionYearPatterns) {
            const match = prompt.match(pattern);
            if (match) {
                const year = parseInt(match[1]);
                // Validar que sea un año razonable (2018 en adelante)
                if (year >= 2018 && year <= new Date().getFullYear() + 1) {
                    analysis.providedData.anio_seleccionado = year;
                    analysis.providedData.year_regeneracion = year;
                    break;
                }
            }
        }
    }

    // Detectar botones
    if (lowerPrompt.includes('botón') || lowerPrompt.includes('boton') || lowerPrompt.includes('button') || lowerPrompt.includes('btn')) {
        // Extraer texto del botón
        const btnTextMatch = prompt.match(/(?:botón|boton|button|btn)\s+(?:que\s+diga|con\s+el\s+texto|texto)\s+["']?([^"'\n]+)["']?/i);
        if (btnTextMatch) {
            // Mapear a btn_text_slides_1 que es lo que espera el endpoint
            analysis.providedData.btn_text_slides_1 = btnTextMatch[1].trim();
            analysis.providedData.texto = btnTextMatch[1].trim(); // También para botones simples
        } else {
            // Texto por defecto para botones
                // Mapear a btn_text_slides_1 que es lo que espera el endpoint
                analysis.providedData.btn_text_slides_1 = 'Ver más';
            analysis.providedData.texto = 'Ver más';
        }
    }

    // Extraer tags/categorías para componentes que las requieren
    // Patrones para detectar tags: "categoría X", "tag Y", "con la categoría Z", etc.
    const tagPatterns = [
        /(?:categoría|categoria|tag)\s+(?:es\s+)?["']?([^"'\n\.]+)["']?/i,
        /(?:con\s+)?(?:la\s+)?(?:categoría|categoria|tag)\s+["']?([^"'\n\.]+)["']?/i,
        /(?:de\s+)?(?:categoría|categoria|tag)\s+["']?([^"'\n\.]+)["']?/i,
        /(?:para\s+)?(?:la\s+)?(?:categoría|categoria|tag)\s+["']?([^"'\n\.]+)["']?/i,
        // Patrón adicional para "categoría de X" o "categoría X"
        /(?:categoría|categoria)\s+(?:de\s+)?["']?([^"'\n\.]+)["']?/i
    ];

    let tagFound = false;
    for (const pattern of tagPatterns) {
        const match = prompt.match(pattern);
        if (match && match[1]) {
            const tagName = match[1].trim();
            // Guardar el nombre de la tag para buscarla después
            analysis.providedData.tagName = tagName;
            analysis.providedData.fk_id_cat_tag = tagName; // Temporal, se resolverá después
            tagFound = true;
            break;
        }
    }

    // Si hay un componente pendiente que requiere tag y no se encontró con patrones,
    // intentar detectar si el prompt completo es solo el nombre de una categoría
    // (esto se manejará mejor en analyzePrompt con acceso a la BD)
    if (!tagFound && pendingComponentForTag && 
        (pendingComponentForTag.id === 8 || pendingComponentForTag.id === 24)) {
        // El prompt podría ser solo el nombre de la categoría
        // Se procesará en analyzePrompt donde tenemos acceso a getAvailableTags
        const cleanPrompt = prompt.trim();
        // Si el prompt es corto y no contiene palabras de acción, podría ser solo el nombre del tag
        if (cleanPrompt.length < 50 && !/(?:crear|crea|quiero|necesito|hacer|agregar)/i.test(cleanPrompt)) {
            // Guardar como posible tagName para procesar después
            analysis.providedData.possibleTagName = cleanPrompt;
        }
    }
}

/**
 * Verifica si ya existe un acordeón en la página
 */
async function checkAccordionExists(pageId) {
    try {
        const secciones = await seccion.findAll({
            where: { fk_id_wb_pagina: pageId, vigente: true },
            include: [{
                model: columna,
                as: 'columnas',
                required: false,
                where: { vigente: true },
                include: [{
                    model: componente,
                    as: 'componentes',
                    required: false,
                    where: { vigente: true },
                    include: [{
                        model: tipoComponente,
                        as: 'tipoComponente',
                        required: false,
                        where: {
                            table_componente: 'wb_comp_acordeon',
                            vigente: true
                        }
                    }]
                }]
            }]
        });

        for (const sec of secciones) {
            if (sec.columnas) {
                for (const col of sec.columnas) {
                    if (col.componentes) {
                        for (const comp of col.componentes) {
                            if (comp.tipoComponente && comp.tipoComponente.table_componente === 'wb_comp_acordeon') {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    } catch (error) {
        console.error('Error checking accordion:', error);
        return false;
    }
}

/**
 * Verifica si tiene suficientes datos para crear el componente
 */
function checkIfHasEnoughData(component, providedData, missingFields) {
    if (!missingFields || missingFields.length === 0) {
        return true;
    }

    // Para componentes con slides, si tiene al menos título y texto, es suficiente
    if (component.hasSlides) {
        const hasTitle = providedData.titulo_slides_1 || providedData.titulo;
        const hasText = providedData.text_slides_1 || providedData.texto;
        if (hasTitle && hasText) {
            return true; // Tiene lo mínimo para crear
        }
    }

    // Redes sociales: siempre se puede crear (URLs reales o placeholders del agente).
    if (component.id === 16) {
        return true;
    }

    // Para componentes simples, verificar campos críticos
    const criticalFields = ['titulo', 'texto', 'liga', 'url_link'];
    const hasCritical = criticalFields.some(field => providedData[field]);

    // Si solo falta archivo pero tiene otros datos, puede crear
    if (missingFields.length === 1 && missingFields[0] === 'archivo' && hasCritical) {
        return true;
    }

    return false;
}

/**
 * Genera un mensaje inteligente cuando está listo para crear
 */
function generateReadyToCreateMessage(component, providedData) {
    const componentName = component.name.toLowerCase();
    let message = `Perfecto, tengo suficiente información para crear un ${componentName}.`;

    if (component.hasSlides) {
        const numSlides = providedData.numSlides || 1;
        message += ` Voy a crear ${numSlides} ${numSlides === 1 ? 'slide' : 'slides'}.`;
    }

    if (providedData.titulo) {
        message += ` El título será: "${providedData.titulo}".`;
    }

    message += ' ¿Procedo con la creación?';
    return message;
}

/**
 * Genera un mensaje inteligente para datos faltantes
 */
async function generateSmartMissingDataMessage(component, missingFields, providedData, idapp) {
    const fieldNames = {
        'titulo': 'título',
        'texto': 'texto',
        'liga': 'URL de destino',
        'url_link': 'URL de enlace',
        'fk_id_cat_tag': 'tag o categoría',
        'archivo': 'imagen o archivo',
        'titulo_slides': 'título para cada slide',
        'text_slides': 'texto para cada slide',
        'text_btn_slides': 'texto del botón para cada slide',
        'url_slides': 'URL del botón para cada slide',
        'orden_visible_slides': 'orden de visualización',
        'anio_slides': 'año para cada slide',
        'anio_seleccionado': 'año seleccionado',
        'year_regeneracion': 'año de regeneración',
        'facebook': 'URL de Facebook',
        'facebook_link': 'enlace de Facebook',
        'instagram': 'URL de Instagram',
        'instagram_link': 'enlace de Instagram',
        'tiktok': 'URL de TikTok',
        'tiktok_link': 'enlace de TikTok',
        'x_twitter': 'URL de Twitter/X',
        'x_twitter_link': 'enlace de Twitter/X',
        'yt': 'URL de YouTube',
        'yt_link': 'enlace de YouTube',
        'f_video': 'fecha del video'
    };

    // Si falta fk_id_cat_tag, obtener y listar las categorías disponibles
    if (missingFields.includes('fk_id_cat_tag')) {
        const availableTags = await getAvailableTags(component.id, idapp);
        if (availableTags.length > 0) {
            const tagList = availableTags.map(t => `• ${t.name}`).join('\n');
            return `Para crear un ${component.name.toLowerCase()}, necesito que me indiques la categoría o tag que deseas usar.\n\nLas categorías disponibles son:\n${tagList}\n\n¿Cuál categoría deseas usar?`;
        }
    }

    // Si es componente de regeneración, mostrar mensaje especial
    if (component.id === 17) {
        const currentYear = new Date().getFullYear();
        const minYear = 2018;
        
        if (providedData.anio_seleccionado || providedData.year_regeneracion || providedData.anio) {
            const year = providedData.anio_seleccionado || providedData.year_regeneracion || providedData.anio;
            return `Perfecto, he detectado el año ${year} para el componente de regeneración. ¿Procedo con la creación?`;
        } else {
            return `Para crear un componente de ${component.name.toLowerCase()}, necesito que me indiques el año que deseas mostrar.\n\nEl año debe estar entre ${minYear} y ${currentYear}.\n\n¿Qué año deseas seleccionar?`;
        }
    }

    // Si es componente de redes sociales, mostrar mensaje especial
    if (component.id === 16) {
        const availableNetworks = ['Facebook', 'Instagram', 'TikTok', 'Twitter/X', 'YouTube'];
        const networkList = availableNetworks.map(n => `• ${n}`).join('\n');
        
        // Verificar qué redes ya se proporcionaron
        const providedNetworks = [];
        if (providedData.facebook || providedData.facebook_link) providedNetworks.push('Facebook');
        if (providedData.instagram || providedData.instagram_link) providedNetworks.push('Instagram');
        if (providedData.tiktok || providedData.tiktok_link) providedNetworks.push('TikTok');
        if (providedData.x_twitter || providedData.x_twitter_link) providedNetworks.push('Twitter/X');
        if (providedData.yt || providedData.yt_link) providedNetworks.push('YouTube');
        
        if (providedNetworks.length > 0) {
            return `Perfecto, he detectado las siguientes redes sociales: ${providedNetworks.join(', ')}.\n\nPuedes agregar más redes o proceder con la creación. Las redes disponibles son:\n${networkList}\n\n¿Deseas agregar más redes o proceder con la creación?`;
        } else {
            return `Para crear un componente de ${component.name.toLowerCase()}, necesito que me indiques las URLs de las redes sociales que deseas incluir.\n\nLas redes sociales disponibles son:\n${networkList}\n\nPuedes proporcionar las URLs en formato:\n• "de facebook: [URL]"\n• "de instagram: [URL]"\n• "de twitter: [URL]"\n• etc.\n\nO simplemente proporciona las URLs y las detectaré automáticamente. ¿Qué redes sociales deseas incluir?`;
        }
    }

    // Separar campos críticos de opcionales
    const criticalFields = ['titulo', 'texto', 'liga', 'url_link', 'titulo_slides', 'text_slides'];
    const critical = missingFields.filter(f => criticalFields.some(cf => f.includes(cf)));
    const optional = missingFields.filter(f => !criticalFields.some(cf => f.includes(cf)));

    let message = `Para crear un ${component.name.toLowerCase()}`;

    if (component.hasSlides) {
        message += ', necesito para cada slide: ';
    } else {
        message += ', necesito: ';
    }

    if (critical.length > 0) {
        const criticalNames = critical.map(f => fieldNames[f] || f).join(', ');
        message += criticalNames;

        if (optional.length > 0) {
            message += '. También sería útil: ' + optional.map(f => fieldNames[f] || f).join(', ');
        }
    } else {
        message += optional.map(f => fieldNames[f] || f).join(', ');
    }

    message += '. ¿Puedes proporcionarme esta información? Si no tienes todos los datos, puedo crear el componente con valores por defecto y luego puedes editarlo. ¿Deseas continuar?';

    return message;
}

/**
 * Genera una respuesta útil cuando no se identifica el componente
 */
function generateHelpfulResponse(prompt) {
    const lowerPrompt = prompt.toLowerCase();

    // Sugerencias contextuales
    if (lowerPrompt.includes('card') || lowerPrompt.includes('tarjeta')) {
        return 'Veo que mencionas "card" o "tarjeta". ¿Te refieres a un "Flip Card", un "Card de Personas", o un "Card" simple? Por favor, sé más específico.';
    }

    if (lowerPrompt.includes('imagen') || lowerPrompt.includes('foto')) {
        return 'Veo que quieres trabajar con imágenes. ¿Quieres crear una "Galería", un "Carrusel", o simplemente una "Imagen"?';
    }

    if (lowerPrompt.includes('slide') || lowerPrompt.includes('diapositiva')) {
        return 'Veo que mencionas slides. ¿Quieres crear un "Carrusel", una "Galería", o una "Línea de tiempo"?';
    }

    // Respuesta genérica con ejemplos
    return 'No pude identificar qué componente quieres crear. Aquí tienes algunos ejemplos:\n' +
        '• "Quiero un carrusel con 3 slides"\n' +
        '• "Crear un botón que diga Ver más"\n' +
        '• "Agregar un título y un texto"\n' +
        '• "Card personas"\n' +
        '• "Flip card con título y texto"\n\n' +
        '¿Podrías ser más específico sobre qué componente necesitas?';
}

/**
 * Genera un mensaje amigable para solicitar datos faltantes (versión legacy para compatibilidad)
 */
async function generateMissingDataMessage(component, missingFields, idapp = null) {
    return await generateSmartMissingDataMessage(component, missingFields, {}, idapp);
}

/**
 * Endpoint principal del agente - Analiza el prompt del usuario
 */
async function analyzeUserPrompt(req, res) {
    try {
        const { prompt, pageId, idapp, conversationContext } = req.body;

        if (!prompt || !pageId || !idapp) {
            return res.status(400).json({
                success: false,
                message: 'Faltan parámetros requeridos: prompt, pageId, idapp'
            });
        }

        let analysis = await analyzePrompt(prompt, pageId, idapp, conversationContext || null);

        // Mejorar análisis con aprendizaje
        analysis = enhanceAnalysisWithLearning(prompt, analysis);

        // Generar respuesta del agente de manera más inteligente
        let agentResponse = '';
        let canCreate = false;
        let pendingContext = null;

        // Si la solicitud está fuera del alcance, retornar mensaje de error
        if (analysis.isOutOfScope) {
            agentResponse = analysis.errors.join(' ');
            return res.json({
                success: true,
                analysis: analysis,
                response: agentResponse,
                canCreate: false,
                conversationContext: null
            });
        }

        // Si es una solicitud de sección solamente
        if (analysis.sectionRequest && analysis.components.length === 0) {
            agentResponse = `Perfecto, voy a crear una sección con ${analysis.sectionRequest.numColumns} ${analysis.sectionRequest.numColumns === 1 ? 'columna' : 'columnas'}. ¿Procedo con la creación?`;
            canCreate = true;
            pendingContext = {
                pendingSection: {
                    numColumns: analysis.sectionRequest.numColumns
                }
            };
            return res.json({
                success: true,
                analysis: analysis,
                response: agentResponse,
                canCreate: canCreate,
                conversationContext: pendingContext
            });
        }

        // Si es una solicitud de sección con componentes
        if (analysis.sectionRequest && analysis.components.length > 0) {
            // Obtener el número de columnas primero
            const numColumns = analysis.sectionRequest.numColumns;
            
            // Detectar si se pide "1 componente en cada columna" o "un componente de personas en cada columna"
            const perColumnPatterns = [
                /(\d+)\s+(?:componente|comp|card|tarjeta|elemento)(?:\s+de\s+\w+)?\s+(?:en|por)\s+cada\s+columna/i,
                /(?:un|una)\s+(?:componente|comp|card|tarjeta|elemento)(?:\s+de\s+\w+)?\s+(?:en|por)\s+cada\s+columna/i,
                /(?:un|una)\s+(?:componente|comp|card|tarjeta|elemento)(?:\s+de\s+\w+)?\s+por\s+columna/i
            ];
            
            let componentsPerColumn = 1;
            let shouldRepeatComponent = false;
            
            for (const pattern of perColumnPatterns) {
                const match = prompt.match(pattern);
                if (match) {
                    if (match[1]) {
                        componentsPerColumn = parseInt(match[1]);
                    } else {
                        componentsPerColumn = 1;
                    }
                    shouldRepeatComponent = true;
                    break;
                }
            }
            
            // Si se detectó "en cada columna", multiplicar los componentes
            if (shouldRepeatComponent) {
                const originalComponent = analysis.components[0];
                const totalComponents = numColumns * componentsPerColumn;
                analysis.components = [];
                for (let i = 0; i < totalComponents; i++) {
                    analysis.components.push({ ...originalComponent });
                }
            }
            
            // Validar que los componentes quepan en las columnas
            const colWidth = 12 / numColumns;
            const incompatibleComponents = [];
            
            for (const comp of analysis.components) {
                if (comp.minSize > colWidth) {
                    incompatibleComponents.push({
                        name: comp.name,
                        minSize: comp.minSize,
                        requiredColWidth: comp.minSize,
                        availableColWidth: colWidth
                    });
                }
            }
            
            if (incompatibleComponents.length > 0) {
                const incompatibleList = incompatibleComponents.map(c => 
                    `• ${c.name} (necesita ${c.requiredColWidth} columnas, pero cada columna tiene ${c.availableColWidth})`
                ).join('\n');
                
                agentResponse = `No puedo crear esta sección porque algunos componentes no caben en las columnas solicitadas:\n\n${incompatibleList}\n\nPor favor, solicita una sección con más columnas o componentes más pequeños.`;
                return res.json({
                    success: true,
                    analysis: analysis,
                    response: agentResponse,
                    canCreate: false,
                    conversationContext: null
                });
            }
            
            // Todos los componentes caben, proceder
            const componentCount = analysis.components.length;
            const componentName = analysis.components[0].name.toLowerCase();
            if (shouldRepeatComponent && componentCount === numColumns) {
                agentResponse = `Perfecto, voy a crear una sección con ${numColumns} ${numColumns === 1 ? 'columna' : 'columnas'} y ${componentCount} ${componentName}${componentCount > 1 ? 's' : ''} (uno en cada columna). ¿Procedo con la creación?`;
            } else {
                const componentNames = analysis.components.map(c => c.name.toLowerCase()).join(', ');
                agentResponse = `Perfecto, voy a crear una sección con ${numColumns} ${numColumns === 1 ? 'columna' : 'columnas'} y los siguientes componentes: ${componentNames}. ¿Procedo con la creación?`;
            }
            canCreate = true;
            pendingContext = {
                pendingSection: {
                    numColumns: numColumns
                },
                pendingComponents: analysis.components,
                providedData: analysis.providedData
            };
            return res.json({
                success: true,
                analysis: analysis,
                response: agentResponse,
                canCreate: canCreate,
                conversationContext: pendingContext
            });
        }

        // Si hay contexto previo con sección pendiente y el usuario confirma
        if (conversationContext && conversationContext.pendingSection && isConfirmation(prompt)) {
            const sectionInfo = await ensureSectionExists(pageId, idapp, conversationContext.pendingSection.numColumns);
            agentResponse = `Sección creada exitosamente con ${conversationContext.pendingSection.numColumns} ${conversationContext.pendingSection.numColumns === 1 ? 'columna' : 'columnas'}.`;
            return res.json({
                success: true,
                analysis: analysis,
                response: agentResponse,
                canCreate: false,
                sectionCreated: true,
                sectionId: sectionInfo.sectionId,
                columnIds: sectionInfo.columnIds,
                conversationContext: null
            });
        }

        if (analysis.errors.length > 0) {
            agentResponse = analysis.errors.join(' ');
        } else if (analysis.isConfirmation && analysis.contextComponent) {
            // Usuario confirmó, permitir crear con datos mínimos
            const component = analysis.contextComponent;
            agentResponse = `Perfecto, voy a crear el ${component.name.toLowerCase()} con los datos proporcionados. ¿Procedo con la creación?`;
            canCreate = true;
            const providedData = { ...analysis.providedData };
            if (analysis.requestedSectionIndex != null) providedData.sectionIndex = analysis.requestedSectionIndex;
            if (analysis.requestedColumnIndex != null) providedData.columnIndex = analysis.requestedColumnIndex;
            pendingContext = {
                pendingComponent: component,
                providedData
            };
        } else if (analysis.sectionRequest && analysis.components.length === 0) {
            // Si hay una solicitud de sección sin componentes, manejarla aquí
            agentResponse = `Perfecto, voy a crear una sección con ${analysis.sectionRequest.numColumns} ${analysis.sectionRequest.numColumns === 1 ? 'columna' : 'columnas'}. ¿Procedo con la creación?`;
            canCreate = true;
            pendingContext = {
                pendingSection: {
                    numColumns: analysis.sectionRequest.numColumns
                }
            };
        } else if (analysis.components.length === 0) {
            // Respuesta más amigable y sugerente
            agentResponse = generateHelpfulResponse(prompt);
        } else {
            const component = analysis.components[0];

            // Crear automáticamente con datos mínimos sin preguntar
            // Solo preguntar si es un componente especial que requiere datos específicos (tags, años, etc.)
            const requiresSpecialData = (component.id === 8 || component.id === 24) && !analysis.providedData.fk_id_cat_tag;
            const requiresYear = component.id === 17 && !analysis.providedData.anio_seleccionado && !analysis.providedData.year_regeneracion;
            
            const providedDataWithPlace = { ...analysis.providedData };
            if (analysis.requestedSectionIndex != null) providedDataWithPlace.sectionIndex = analysis.requestedSectionIndex;
            if (analysis.requestedColumnIndex != null) providedDataWithPlace.columnIndex = analysis.requestedColumnIndex;
            if (requiresSpecialData) {
                // Componente que requiere tag/categoría - pedir el tag
                agentResponse = await generateSmartMissingDataMessage(component, analysis.missingData[component.id] || ['fk_id_cat_tag'], analysis.providedData, idapp);
                pendingContext = {
                    pendingComponent: component,
                    providedData: providedDataWithPlace
                };
            } else if (requiresYear) {
                // Componente que requiere año - pedir el año
                agentResponse = await generateSmartMissingDataMessage(component, analysis.missingData[component.id] || ['anio_seleccionado'], analysis.providedData, idapp);
                pendingContext = {
                    pendingComponent: component,
                    providedData: providedDataWithPlace
                };
            } else {
                // Crear automáticamente con datos mínimos
                const placeMsg = (analysis.requestedSectionIndex != null || analysis.requestedColumnIndex != null)
                    ? ` en la sección ${analysis.requestedSectionIndex != null ? analysis.requestedSectionIndex : 1}${analysis.requestedColumnIndex != null ? `, columna ${analysis.requestedColumnIndex}` : ''}`
                    : '';
                agentResponse = `Perfecto, voy a crear un ${component.name.toLowerCase()} con datos mínimos${placeMsg}.`;
                if (component.id === 16) {
                    ensureRedesSocialesAgentDefaults(providedDataWithPlace);
                    agentResponse += ' Incluiré enlaces de ejemplo del partido (editables en el componente).';
                }
                canCreate = true;
                pendingContext = {
                    pendingComponent: component,
                    providedData: providedDataWithPlace,
                    autoCreate: true // Marcar para creación automática
                };
            }
        }

        return res.json({
            success: true,
            analysis: analysis,
            response: agentResponse,
            canCreate: canCreate || (analysis.components.length > 0 &&
                (!analysis.missingData[analysis.components[0]?.id] ||
                    analysis.missingData[analysis.components[0]?.id]?.length === 0) &&
                analysis.errors.length === 0),
            conversationContext: pendingContext
        });
    } catch (error) {
        console.error('Error analyzing prompt:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al analizar el prompt',
            error: error.message
        });
    }
}

/**
 * Crea una sección con el número especificado de columnas (1-4)
 * @param {number} pageId - ID de la página
 * @param {number} idapp - ID de la aplicación
 * @param {number} numColumns - Número de columnas (1-4), por defecto 1
 * @returns {Promise<{sectionId: number, orden: number, columnIds: number[]}>}
 */
async function ensureSectionExists(pageId, idapp, numColumns = 1) {
    try {
        // Validar número de columnas
        if (numColumns < 1 || numColumns > 4) {
            throw new Error('El número de columnas debe estar entre 1 y 4');
        }

        // Siempre crear nueva sección para asegurar estructura limpia (Sección -> Columna -> Componente)
        const lastSection = await seccion.findOne({
            where: { fk_id_wb_pagina: pageId, vigente: true },
            order: [['orden_visible', 'DESC']]
        });

        const orden = lastSection ? lastSection.orden_visible + 1 : 1;

        const newSection = await seccion.create({
            fk_id_wb_pagina: pageId,
            fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
            wb_margin: [0, 0, 0, 0],
            wb_padding: [0, 0, 0, 0],
            fk_id_cat_wb_width: 1,
            wb_num_col: numColumns,
            vigente: true,
            f_reg: new Date(),
            orden_visible: orden
        });

        // Crear las columnas solicitadas
        const columnIds = [];
        for (let i = 0; i < numColumns; i++) {
            const newCol = await columna.create({
                fk_id_wb_pag_seccion: newSection.id_wb_pag_seccion,
                fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                wb_padding: [0, 0, 0, 0],
                vigente: true,
                f_reg: new Date(),
                orden_visible: i + 1
            });
            columnIds.push(newCol.id_wb_pag_columna);
        }

        return { 
            sectionId: newSection.id_wb_pag_seccion, 
            orden,
            columnIds,
            numColumns
        };
    } catch (error) {
        console.error('Error ensuring section:', error);
        throw error;
    }
}

/**
 * Crea una columna si no existe o no es adecuada
 * Valida que el tamaño mínimo del componente quepa en la columna
 * @param {number} sectionId - ID de la sección
 * @param {number} minSize - Tamaño mínimo requerido del componente (3, 6, 9, 12)
 * @param {number} idapp - ID de la aplicación
 * @param {number} requestedColumnIndex - Índice de la columna solicitada (0-based, opcional)
 * @returns {Promise<number>} ID de la columna
 */
async function ensureColumnExists(sectionId, minSize, idapp, requestedColumnIndex = null) {
    try {
        // Buscar columnas existentes en la sección
        const columns = await columna.findAll({
            where: { fk_id_wb_pag_seccion: sectionId, vigente: true },
            order: [['orden_visible', 'ASC']]
        });

        const numCols = columns.length;
        const colWidth = numCols > 0 ? 12 / numCols : 12;

        // Validar que el componente quepa en el ancho de columna disponible
        if (minSize > colWidth && numCols > 0) {
            // El componente no cabe en las columnas existentes
            // Necesitamos crear una nueva columna o usar una columna vacía
            // Verificar si hay columnas vacías que puedan acomodar el componente
            let suitableColumn = null;
            
            for (let i = 0; i < columns.length; i++) {
                // Verificar si la columna está vacía (sin componentes)
                const compsInCol = await componente.count({
                    where: {
                        fk_id_wb_pag_columna: columns[i].id_wb_pag_columna,
                        vigente: true
                    }
                });
                
                if (compsInCol === 0 && colWidth >= minSize) {
                    suitableColumn = columns[i];
                    break;
                }
            }
            
            if (!suitableColumn) {
                // No hay columna adecuada, crear una nueva
                const newCol = await columna.create({
                    fk_id_wb_pag_seccion: sectionId,
                    fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                    wb_padding: [0, 0, 0, 0],
                    vigente: true,
                    f_reg: new Date(),
                    orden_visible: numCols + 1
                });
                
                // Actualizar wb_num_col de la sección
                await seccion.update(
                    { wb_num_col: numCols + 1 },
                    { where: { id_wb_pag_seccion: sectionId } }
                );
                
                return newCol.id_wb_pag_columna;
            }
            
            return suitableColumn.id_wb_pag_columna;
        }

        // Si el componente necesita tamaño 12, necesita su propia columna
        if (minSize === 12) {
            if (numCols > 0 && colWidth < 12) {
                // Verificar si hay una columna vacía de tamaño 12
                let emptyCol = null;
                for (const col of columns) {
                    const compsInCol = await componente.count({
                        where: {
                            fk_id_wb_pag_columna: col.id_wb_pag_columna,
                            vigente: true
                        }
                    });
                    if (compsInCol === 0) {
                        emptyCol = col;
                        break;
                    }
                }
                
                if (!emptyCol) {
                    // Crear nueva columna
                    const newCol = await columna.create({
                        fk_id_wb_pag_seccion: sectionId,
                        fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                        wb_padding: [0, 0, 0, 0],
                        vigente: true,
                        f_reg: new Date(),
                        orden_visible: numCols + 1
                    });
                    
                    // Actualizar wb_num_col de la sección
                    await seccion.update(
                        { wb_num_col: numCols + 1 },
                        { where: { id_wb_pag_seccion: sectionId } }
                    );
                    
                    return newCol.id_wb_pag_columna;
                }
                return emptyCol.id_wb_pag_columna;
            } else if (numCols === 0) {
                // Crear primera columna
                const newCol = await columna.create({
                    fk_id_wb_pag_seccion: sectionId,
                    fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                    wb_padding: [0, 0, 0, 0],
                    vigente: true,
                    f_reg: new Date(),
                    orden_visible: 1
                });
                return newCol.id_wb_pag_columna;
            } else {
                // Usar primera columna si está vacía
                const compsInFirstCol = await componente.count({
                    where: {
                        fk_id_wb_pag_columna: columns[0].id_wb_pag_columna,
                        vigente: true
                    }
                });
                
                if (compsInFirstCol === 0) {
                    return columns[0].id_wb_pag_columna;
                } else {
                    // Crear nueva columna
                    const newCol = await columna.create({
                        fk_id_wb_pag_seccion: sectionId,
                        fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                        wb_padding: [0, 0, 0, 0],
                        vigente: true,
                        f_reg: new Date(),
                        orden_visible: numCols + 1
                    });
                    
                    // Actualizar wb_num_col de la sección
                    await seccion.update(
                        { wb_num_col: numCols + 1 },
                        { where: { id_wb_pag_seccion: sectionId } }
                    );
                    
                    return newCol.id_wb_pag_columna;
                }
            }
        } else {
            // Componente pequeño, puede compartir columna
            if (numCols === 0) {
                const newCol = await columna.create({
                    fk_id_wb_pag_seccion: sectionId,
                    fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
                    wb_padding: [0, 0, 0, 0],
                    vigente: true,
                    f_reg: new Date(),
                    orden_visible: 1
                });
                return newCol.id_wb_pag_columna;
            } else {
                // Si se solicitó una columna específica, usarla si está disponible
                if (requestedColumnIndex !== null && requestedColumnIndex < columns.length) {
                    const requestedCol = columns[requestedColumnIndex];
                    const compsInCol = await componente.count({
                        where: {
                            fk_id_wb_pag_columna: requestedCol.id_wb_pag_columna,
                            vigente: true
                        }
                    });
                    
                    // Validar que el componente quepa en la columna solicitada
                    const requestedColWidth = 12 / numCols;
                    if (requestedColWidth >= minSize && compsInCol === 0) {
                        return requestedCol.id_wb_pag_columna;
                    }
                }
                
                // Buscar una columna vacía que pueda acomodar el componente
                for (const col of columns) {
                    const compsInCol = await componente.count({
                        where: {
                            fk_id_wb_pag_columna: col.id_wb_pag_columna,
                            vigente: true
                        }
                    });
                    
                    if (compsInCol === 0 && colWidth >= minSize) {
                        return col.id_wb_pag_columna;
                    }
                }
                
                // Si no hay columna adecuada, usar la última
                return columns[columns.length - 1].id_wb_pag_columna;
            }
        }
    } catch (error) {
        console.error('Error ensuring column:', error);
        throw error;
    }
}

/**
 * Resuelve índice de sección/columna (1-based) a IDs reales de la página.
 * @param {number} pageId - ID de la página
 * @param {number} sectionIndex1Based - Número de sección (1 = primera)
 * @param {number} columnIndex1Based - Número de columna (1 = primera), opcional
 * @returns {Promise<{sectionId: number, columnId: number}|null>}
 */
async function getSectionAndColumnIdsByIndex(pageId, sectionIndex1Based, columnIndex1Based) {
    if (!sectionIndex1Based || sectionIndex1Based < 1) return null;
    const sections = await seccion.findAll({
        where: { fk_id_wb_pagina: pageId, vigente: true },
        order: [['orden_visible', 'ASC']],
        include: [{
            model: columna,
            as: 'columnas',
            required: false,
            where: { vigente: true },
            order: [['orden_visible', 'ASC']]
        }]
    });
    const secIdx = sectionIndex1Based - 1;
    if (secIdx >= sections.length) return null;
    const sec = sections[secIdx];
    const columnas = sec.columnas || [];
    const colIdx = (columnIndex1Based != null && columnIndex1Based >= 1) ? columnIndex1Based - 1 : 0;
    if (colIdx >= columnas.length) return null;
    const col = columnas[colIdx];
    return col ? { sectionId: sec.id_wb_pag_seccion, columnId: col.id_wb_pag_columna } : null;
}

/**
 * Endpoint para crear componente desde el agente
 */
async function createComponentFromAgent(req, res) {
    try {
        console.log('🎯 createComponentFromAgent llamado');
        console.log('📦 req.body:', req.body);
        const { componentId, componentData, pageId, idapp } = req.body;

        if (!componentId || !pageId || !idapp) {
            console.error('❌ Faltan parámetros:', { componentId, pageId, idapp });
            return res.status(400).json({
                success: false,
                message: 'Faltan parámetros requeridos'
            });
        }
        
        console.log('✅ Parámetros válidos:', { componentId, pageId, idapp });

        const config = COMPONENT_CONFIG[componentId];
        if (!config) {
            return res.status(400).json({
                success: false,
                message: 'Tipo de componente no válido'
            });
        }

        // Verificar acordeón
        if (componentId === 9) {
            const hasAccordion = await checkAccordionExists(pageId);
            if (hasAccordion) {
                return res.status(400).json({
                    success: false,
                    message: 'Solo puede haber un componente acordeón por página'
                });
            }
        }

        // Resolver sección/columna: por IDs o por índice (1-based) indicado por el usuario
        let sectionId = componentData?.sectionId;
        let columnId = componentData?.columnId;
        const sectionIndex = componentData?.sectionIndex != null ? parseInt(componentData.sectionIndex, 10) : null;
        const columnIndex = componentData?.columnIndex != null ? parseInt(componentData.columnIndex, 10) : null;
        if ((sectionIndex != null || columnIndex != null) && (!sectionId || !columnId)) {
            const resolved = await getSectionAndColumnIdsByIndex(
                pageId,
                sectionIndex != null ? sectionIndex : 1,
                columnIndex != null ? columnIndex : 1
            );
            if (resolved) {
                sectionId = resolved.sectionId;
                columnId = resolved.columnId;
            }
            delete componentData.sectionIndex;
            delete componentData.columnIndex;
        }

        if (sectionId && columnId) {
            // Validar que la sección y columna existan
            const sectionExists = await seccion.findOne({
                where: { id_wb_pag_seccion: sectionId, fk_id_wb_pagina: pageId, vigente: true }
            });
            const columnExists = await columna.findOne({
                where: { id_wb_pag_columna: columnId, fk_id_wb_pag_seccion: sectionId, vigente: true }
            });

            if (!sectionExists || !columnExists) {
                return res.status(400).json({
                    success: false,
                    message: 'La sección o columna especificada no existe o no es válida'
                });
            }
        } else {
            // Verificar si hay una solicitud de sección con número específico de columnas
            // Esto puede venir del conversationContext o del componentData
            let numColumns = 1;
            if (componentData && componentData.numColumns) {
                numColumns = parseInt(componentData.numColumns);
                if (numColumns < 1 || numColumns > 4) {
                    numColumns = 1;
                }
            }

            // Asegurar que existe sección con el número de columnas solicitado
            const sectionInfo = await ensureSectionExists(pageId, idapp, numColumns);
            sectionId = sectionInfo.sectionId;
        }

        // Si no se proporcionó columnId, buscar o crear una columna adecuada
        if (!columnId) {
            // Buscar columnas existentes en la sección
            const existingColumns = await columna.findAll({
                where: { fk_id_wb_pag_seccion: sectionId, vigente: true },
                order: [['orden_visible', 'ASC']]
            });

            if (existingColumns.length > 0) {
                // Usar la primera columna disponible que pueda acomodar el componente
                const numCols = existingColumns.length;
                const colWidth = 12 / numCols;
                
                if (config.minSize <= colWidth) {
                    // Buscar una columna vacía
                    let suitableColumnId = null;
                    for (const col of existingColumns) {
                        const compsInCol = await componente.count({
                            where: {
                                fk_id_wb_pag_columna: col.id_wb_pag_columna,
                                vigente: true
                            }
                        });
                        if (compsInCol === 0) {
                            suitableColumnId = col.id_wb_pag_columna;
                            break;
                        }
                    }
                    columnId = suitableColumnId || existingColumns[0].id_wb_pag_columna;
                } else {
                    // El componente no cabe, crear una nueva columna
                    columnId = await ensureColumnExists(sectionId, config.minSize, idapp);
                }
            } else {
                // No hay columnas, crear una
                columnId = await ensureColumnExists(sectionId, config.minSize, idapp);
            }
        }

        // Generar tokens
        const cy = generateCyToken(idapp);
        const dataComp = generateDataCompToken(idapp, config.table);

        // Validar que componentes con tag tengan la tag antes de crear
        if ((componentId === 8 || componentId === 24) && !componentData.fk_id_cat_tag) {
            return res.status(400).json({
                success: false,
                message: 'Este componente requiere una categoría o tag. Por favor, proporciona la categoría que deseas usar.'
            });
        }

        // Forzar siempre skipFile ya que tenemos fallbacks en las vistas
        componentData.skipFile = true;

        // Preparar datos para el componente con valores por defecto
        const defaultData = prepareDefaultData(componentId, componentData);

        // Asegurar que no se procesen archivos en el backend
        delete defaultData.fk_id_file;
        delete defaultData['cargar-imag-slides-1'];
        delete defaultData['cargar-imag'];
        delete defaultData.skipFile;

        // Determinar el endpoint correcto según el tipo de componente
        let endpoint = '/CreateComp';
        let tipoAcordeon = null;
        
        if (config.hasSlides) {
            endpoint = '/CreateFirstSlide';
        } else if (componentId === 9) {
            // Acordeón requiere endpoint especial
            endpoint = '/crear-componente-acordeon';
            
            // Buscar el ID del tipo de componente acordeón en el catálogo
            tipoAcordeon = await paginaModel.tipoComponente.findOne({
                where: {
                    table_componente: 'wb_comp_acordeon',
                    vigente: true
                },
                attributes: ['id_cat_wb_componente']
            });
            
            if (!tipoAcordeon) {
                return res.status(400).json({
                    success: false,
                    message: 'No se encontró el tipo de componente acordeón en el catálogo'
                });
            }
        }

        // Preparar datos para el componente
        const componentPayload = {
            cy,
            dataComp: componentId === 9 && tipoAcordeon ? tipoAcordeon.id_cat_wb_componente.toString() : componentId.toString(),
            tablecomp: config.table,
            orden: 1,
            idpag: pageId,
            idsec: sectionId,
            idcol: columnId,
            CompSlidesId: '0', // Importante: debe ser '0' para crear un nuevo componente slide
            // Señal explícita para que endpoints legacy (p.ej. slides) creen como vigente
            fromAgent: 'true',
            ...defaultData
        };

        // Asegurar que idsec e idcol estén en el payload (por si acaso se sobrescribieron)
        componentPayload.idsec = sectionId;
        componentPayload.idcol = columnId;

        // Ajustar payload para acordeón según lo que espera createComponenteAcordeon
        if (componentId === 9) {
            componentPayload.titulo = componentData.titulo || 'Nuevo Acordeón';
            componentPayload.descripcion = componentData.descripcion || '';
            componentPayload.acordeonId = '0'; // 0 para crear nuevo
            componentPayload.i = cy; // El endpoint de acordeón usa 'i' en lugar de 'cy'
            // Eliminar campos que no necesita el endpoint de acordeón
            delete componentPayload.cy;
            delete componentPayload.tablecomp;
            delete componentPayload.CompSlidesId;
        }
        
        console.log('✅ Payload preparado:', componentPayload);
        console.log('📤 Endpoint:', endpoint);
        
        // Retornar los datos para que el frontend haga la petición
        return res.json({
            success: true,
            message: 'Datos preparados para crear el componente',
            payload: componentPayload,
            endpoint: endpoint
        });
    } catch (error) {
        console.error('Error creating component:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al preparar la creación del componente',
            error: error.message
        });
    }
}

/**
 * Prepara datos por defecto para componentes de manera inteligente
 */
function prepareDefaultData(componentId, providedData) {
    const data = { ...providedData };
    const config = COMPONENT_CONFIG[componentId];

    if (!config) return data;

    // Para componentes con slides
    if (config.hasSlides) {
        const numSlides = data.numSlides || 1;

        // Preparar datos para el primer slide (requerido)
        // Mapear datos genéricos a datos de slides si existen
        if (data.titulo && !data.titulo_slides_1) {
            data.titulo_slides_1 = data.titulo;
        }
        if (data.texto && !data.text_slides_1) {
            data.text_slides_1 = data.texto;
        }
        if (data.url_link && !data.url_slides_1) {
            data.url_slides_1 = data.url_link;
        }
        if (data.liga && !data.url_slides_1) {
            data.url_slides_1 = data.liga;
        }

        // Valores por defecto inteligentes
        if (!data.titulo_slides_1) {
            data.titulo_slides_1 = numSlides > 1 ? 'Slide 1' : 'Título del slide';
        }
        if (!data.text_slides_1) {
            data.text_slides_1 = '';
        }
        if (!data.orden_visible_slides_1) {
            data.orden_visible_slides_1 = 1;
        }

        // Para carrusel específicamente
        if (componentId === 5) {
            // El endpoint espera btn_text_slides_1, no text_btn_slides_1
            if (!data.btn_text_slides_1 && !data.text_btn_slides_1) {
                data.btn_text_slides_1 = data.texto || 'Ver más';
            } else if (data.text_btn_slides_1 && !data.btn_text_slides_1) {
                // Si viene como text_btn_slides_1, mapearlo a btn_text_slides_1
                data.btn_text_slides_1 = data.text_btn_slides_1;
            }
            if (!data.url_slides_1) {
                data.url_slides_1 = data.url_link || data.liga || '#';
            }
            // Asegurar que orden_visible_slides_1 esté presente
            if (!data.orden_visible_slides_1) {
                data.orden_visible_slides_1 = 1;
            }
        }

        // Para línea de tiempo
        if (componentId === 14) {
            if (!data.anio_slides_1) {
                data.anio_slides_1 = data.anio || new Date().getFullYear();
            }
        }

        // Para galería, no necesita botón ni URL
    } else {
        // Para componentes simples
        if (config.requiredFields.includes('titulo') && !data.titulo) {
            // Intentar inferir del contexto
            if (componentId === 1) {
                data.titulo = 'Título de página';
            } else if (componentId === 21) {
                data.titulo = 'Persona';
            } else {
                data.titulo = 'Título';
            }
        }

        if (config.requiredFields.includes('texto') && !data.texto) {
            // Para componente de texto (id: 3), usar texto más extenso por defecto
            if (componentId === 3) {
                data.texto = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.\n\nSed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.';
            } else {
                data.texto = '';
            }
        }

        // Para botones y links
        if (config.requiredFields.includes('liga') && !data.liga) {
            data.liga = data.url_link || '#';
        }
        if (config.requiredFields.includes('url_link') && !data.url_link) {
            data.url_link = data.liga || '#';
        }

        // Para botones, si no hay texto, usar uno por defecto
        if (componentId === 4 && !data.texto) {
            data.texto = 'Ver más';
        }

        // Para regeneración, asegurar que el año esté mapeado correctamente
        if (componentId === 17) {
            // Mapear año a los campos correctos
            if (data.anio_seleccionado && !data.year_regeneracion) {
                data.year_regeneracion = data.anio_seleccionado;
            }
            if (data.year_regeneracion && !data.anio_seleccionado) {
                data.anio_seleccionado = data.year_regeneracion;
            }
            if (data.anio && !data.anio_seleccionado) {
                data.anio_seleccionado = data.anio;
                data.year_regeneracion = data.anio;
            }
            
            // Validar que el año esté presente y sea válido
            const year = data.anio_seleccionado || data.year_regeneracion || data.anio;
            if (!year) {
                // Si no hay año, lanzar error - no usar valor por defecto
                throw new Error('El año es obligatorio para el componente de regeneración');
            }
            
            // Validar que el año esté en el rango permitido
            const currentYear = new Date().getFullYear();
            if (year < 2018 || year > currentYear + 1) {
                throw new Error(`El año debe estar entre 2018 y ${currentYear + 1}`);
            }
        }

        // Para redes sociales: sincronizar nombre/enlace; si todo vacío, placeholders institucionales editables
        if (componentId === 16) {
            const socialNetworksMap = {
                facebook: ['facebook', 'facebook_link'],
                instagram: ['instagram', 'instagram_link'],
                tiktok: ['tiktok', 'tiktok_link'],
                twitter: ['x_twitter', 'x_twitter_link'],
                youtube: ['yt', 'yt_link']
            };

            for (const [, fields] of Object.entries(socialNetworksMap)) {
                const [nameField, linkField] = fields;
                if (data[nameField] && !data[linkField]) {
                    data[linkField] = data[nameField];
                }
                if (data[linkField] && !data[nameField]) {
                    data[nameField] = data[linkField];
                }
            }
            ensureRedesSocialesAgentDefaults(data);
        }

        // Para video, f_video debe ser una fecha (timestamp), no un string
        if (componentId === 23) {
            if (!data.f_video) {
                // Si no se proporciona fecha, usar la fecha actual
                data.f_video = new Date().toISOString();
            } else if (typeof data.f_video === 'string' && data.f_video === 'External') {
                // Si viene como 'External', convertir a fecha actual
                data.f_video = new Date().toISOString();
            } else if (typeof data.f_video === 'string' && !data.f_video.match(/^\d{4}-\d{2}-\d{2}/)) {
                // Si es un string que no parece una fecha, convertir a fecha actual
                data.f_video = new Date().toISOString();
            }
        }
    }

    // Mapeo final: asegurar que text_btn_slides_1 se mapee a btn_text_slides_1 para carruseles
    if (componentId === 5 && data.text_btn_slides_1 && !data.btn_text_slides_1) {
        data.btn_text_slides_1 = data.text_btn_slides_1;
    }
    
    return data;
}

/**
 * Sistema de aprendizaje del agente - Mejora las respuestas basándose en el contexto
 */
const AGENT_LEARNING = {
    // Patrones aprendidos de interacciones exitosas
    successfulPatterns: [],

    // Mapeo de sinónimos comunes
    synonyms: {
        'crear': ['crea', 'hacer', 'agregar', 'añadir', 'poner', 'insertar'],
        'quiero': ['necesito', 'deseo', 'busco', 'requiero'],
        'componente': ['elemento', 'widget', 'bloque', 'sección'],
        'slide': ['diapositiva', 'imagen', 'foto', 'elemento'],
        'botón': ['button', 'btn', 'enlace', 'link']
    },

    // Normalizar sinónimos en el prompt
    normalizePrompt(prompt) {
        let normalized = prompt.toLowerCase();
        for (const [word, synonyms] of Object.entries(this.synonyms)) {
            for (const synonym of synonyms) {
                normalized = normalized.replace(new RegExp(`\\b${synonym}\\b`, 'gi'), word);
            }
        }
        return normalized;
    }
};

/**
 * Mejora el análisis usando aprendizaje
 */
function enhanceAnalysisWithLearning(prompt, analysis) {
    const normalized = AGENT_LEARNING.normalizePrompt(prompt);

    // Si el análisis no encontró componentes, intentar con prompt normalizado
    if (analysis.components.length === 0) {
        // Re-analizar con prompt normalizado (esto se haría recursivamente, pero por ahora solo mejoramos la detección)
        // Por ahora, solo mejoramos la extracción de datos
    }

    return analysis;
}

/**
 * Endpoint para crear sección desde el agente
 */
async function createSectionFromAgent(req, res) {
    try {
        console.log('🎯 createSectionFromAgent llamado');
        console.log('📦 req.body:', req.body);
        const { pageId, idapp, numColumns } = req.body;

        if (!pageId || !idapp) {
            console.error('❌ Faltan parámetros:', { pageId, idapp });
            return res.status(400).json({
                success: false,
                message: 'Faltan parámetros requeridos: pageId, idapp'
            });
        }

        // Validar número de columnas
        const columns = numColumns ? parseInt(numColumns) : 1;
        if (columns < 1 || columns > 4) {
            return res.status(400).json({
                success: false,
                message: 'El número de columnas debe estar entre 1 y 4'
            });
        }

        console.log('✅ Parámetros válidos:', { pageId, idapp, numColumns: columns });

        // Crear sección con columnas
        const sectionInfo = await ensureSectionExists(pageId, idapp, columns);

        console.log('✅ Sección creada:', sectionInfo);

        return res.json({
            success: true,
            message: `Sección creada exitosamente con ${columns} ${columns === 1 ? 'columna' : 'columnas'}`,
            sectionId: sectionInfo.sectionId,
            columnIds: sectionInfo.columnIds,
            numColumns: sectionInfo.numColumns,
            orden: sectionInfo.orden
        });
    } catch (error) {
        console.error('Error creating section:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al crear la sección',
            error: error.message
        });
    }
}

module.exports = {
    analyzeUserPrompt,
    createComponentFromAgent,
    createSectionFromAgent,
    analyzePrompt,
    generateMissingDataMessage,
    generateSmartMissingDataMessage,
    generateReadyToCreateMessage,
    generateHelpfulResponse,
    prepareDefaultData,
    checkIfHasEnoughData,
    ensureSectionExists,
    ensureColumnExists,
    COMPONENT_CONFIG,
    KEYWORD_MAP,
    AGENT_KNOWLEDGE,
    AGENT_LEARNING
};
