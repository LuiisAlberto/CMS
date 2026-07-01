/**
 * Script para crear las 3 páginas template por defecto cuando se crea una instancia.
 * Basado en docs/template_pages.md
 *
 * Crea:
 * - 1 Menú con logo, Documentos (CEN, CN), Transparencia, Protección de Datos Personales
 * - 1 Footer con contenido por defecto
 * - 1 Tag "Lorem Ipsum" tipo entrada + 1 tag "Lorem Ipsum" tipo imagen
 * - 7 Entradas (páginas tipo entrada) con tag Lorem Ipsum
 * - Página principal: carrousel, subtitulo, noticias, img, redes
 * - Página secundaria 1: titulopag, subtitulo, texto, acordeon, cards
 * - Página secundaria 2: todos los componentes
 */

const dbConection = require('../config/postgressdb');
const paginaModel = require('../models/paginasModel');
const footerModel = require('../models/footerModel');
const menuModel = require('../models/menuModel');
const rel_sysapp_filesModel = require('../models/rel_sysapp_files');
const filesModel = require('../models/files');
const path = require('path');

const LOREM = {
    titulo: 'Lorem ipsum dolor sit amet consectetur adipiscing elit',
    texto: 'Lorem ipsum dolor sit amet consectetur adipiscing elit suspendisse tortor quis, scelerisque ridiculus rhoncus a viverra turpis praesent vel blandit penatibus, vestibulum iaculis interdum ad cum rutrum urna dictum mattis. Proin montes praesent senectus viverra nascetur ante ut arcu scelerisque, venenatis varius semper quam ultrices morbi fusce ac, dictum himenaeos cursus odio fringilla etiam velit sollicitudin. Libero placerat pulvinar hac duis cubilia praesent eu eleifend, posuere vestibulum litora primis sagittis nunc dapibus.',
    texto2: 'Sagittis vel vehicula gravida suscipit in fames netus accumsan, arcu urna mollis nisl convallis luctus dictumst. Justo eleifend felis parturient dui eget per vel pretium imperdiet morbi, nostra metus vestibulum ut convallis sem turpis curabitur lectus, integer id euismod lobortis scelerisque egestas sociosqu faucibus maecenas. Dictum hac felis lobortis curabitur commodo ante scelerisque cum, vulputate vehicula ultrices fames luctus per himenaeos, taciti fermentum pellentesque augue non ornare sodales.',
    descripcion: 'Lorem ipsum dolor sit amet consectetur adipiscing elit suspendisse tortor quis, scelerisque ridiculus rhoncus a viverra turpis praesent vel blandit penatibus, vestibulum iaculis interdum ad cum rutrum urna dictum mattis.',
    carrousel: {
        titulo: 'Lorem ipsum dolor sit amet consectetur adipiscing elit',
        texto: 'Sagittis vel vehicula gravida suscipit in fames netus accumsan, arcu urna mollis nisl convallis luctus dictumst.',
        btn: 'Lorem ipsum',
        link: 'https://google.com'
    },
    footer: {
        texto_suscripcion: 'Lorem ipsum dolor sit amet consectetur adipiscing elit',
        enlaces: [{ categoria: 'Lorem ipsum', nombre: 'Lorem ipsum', url: 'https://google.com' }],
        email: 'info@morena.si',
        telefono: '56589675',
        direccion: 'Viad. Pdte. Miguel Alemán Valdés 806, Nápoles, Benito Juárez, 03810 Ciudad de México, CDMX',
        copyright: '© 2026 MORENA. Todos los derechos reservados. Aviso de Privacidad'
    },
    redes: {
        facebook: { nombre: 'Morena Sí', link: 'https://www.facebook.com/PartidoMorenaMx/?locale=es_LA' },
        instagram: { nombre: 'Morena Sí', link: 'https://www.instagram.com/morena_partido/' },
        youtube: { nombre: 'Morena Sí', link: 'https://www.youtube.com/@MorenaS%C3%AD-u1q' },
        x: { nombre: 'Morena Sí', link: 'https://x.com/PartidoMorenaMx' },
        tiktok: { nombre: 'Morena Sí', link: 'https://www.tiktok.com/@morena_simx?lang=es' }
    }
};

/** Obtiene el id_cat_wb_componente por table_componente */
async function getTipoComponenteId(tableComp, transaction) {
    const tc = await paginaModel.tipoComponente.findOne({
        where: { table_componente: tableComp, vigente: true },
        attributes: ['id_cat_wb_componente'],
        transaction,
        raw: true
    });
    return tc ? tc.id_cat_wb_componente : null;
}

/** Obtiene el logo file_id de la instancia (rel_sysapp_files, cat_type 8) */
async function getLogoFileId(idapp) {
    try {
        const rel = await rel_sysapp_filesModel.findOne({
            where: { fk_id_sysapp: idapp, fk_id_cat_type_files: 8, vigente: true },
            attributes: ['fk_id_file'],
            raw: true
        });
        return rel ? rel.fk_id_file : null;
    } catch {
        return null;
    }
}

/** Crea un archivo en files apuntando a una ruta por defecto (logo/CDN).
 * Usa la conexión principal (filesMain), sin transacción compartida con postgressdb.
 */
async function crearFileDefault(filePath, fileType) {
    const filesModel = require('../models/files');
    const Files = filesModel.filesMain;
    const newFile = await Files.create({
        file_name: path.basename(filePath),
        file_type: fileType || 'image/png',
        file_path: filePath,
        fk_id_storage: parseInt(process.env.PUBLIC_STORAGE_ACTIVE || '1', 10)
    });
    return newFile.id_file;
}

/** Crea o busca tag por nombre y tipo */
async function getOrCreateTag(tag, tipo, fk_sysapp_type, transaction) {
    let existing = await paginaModel.cat_tags.findOne({
        where: { tag, fk_id_cat_type_tag: tipo, vigente: true, fk_id_sysapp_type: fk_sysapp_type },
        transaction,
        raw: true
    });
    if (!existing) {
        const created = await paginaModel.cat_tags.create({
            tag,
            fk_id_cat_type_tag: tipo,
            vigente: true,
            fk_id_sysapp_type: fk_sysapp_type
        }, { transaction });
        return created.id_cat_tag;
    }
    return existing.id_cat_tag;
}

/** Añade un componente a una columna */
async function addComponente(idCol, tableComp, orden, idTipoComp, extraData, transaction) {
    const comp = await paginaModel.componente.create({
        fk_id_wb_pag_columna: idCol,
        fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
        wb_padding: [10, 10, 10, 10],
        vigente: true,
        f_reg: new Date(),
        orden_visible: orden,
        fk_id_cat_wb_componente: idTipoComp
    }, { transaction });

    if (tableComp === 'wb_comp_subtitulo' && extraData?.texto) {
        await paginaModel.wb_comp_subtitulo.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            texto: extraData.texto,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    } else if (tableComp === 'wb_comp_texto' && extraData?.texto) {
        await paginaModel.wb_comp_texto.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            texto: extraData.texto,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    } else if (tableComp === 'wb_comp_noticias' && extraData?.fk_id_cat_tag) {
        await paginaModel.wb_comp_noticias.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            fk_id_cat_tag: extraData.fk_id_cat_tag,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    } else if (tableComp === 'wb_comp_redes') {
        const r = LOREM.redes;
        await paginaModel.wb_comp_redes.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            facebook: r.facebook?.nombre,
            facebook_link: r.facebook?.link,
            instagram: r.instagram?.nombre,
            instagram_link: r.instagram?.link,
            yt: r.youtube?.nombre,
            yt_link: r.youtube?.link,
            x_twitter: r.x?.nombre,
            x_twitter_link: r.x?.link,
            tiktok: r.tiktok?.nombre,
            tiktok_link: r.tiktok?.link,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    } else if (tableComp === 'wb_comp_img' && extraData) {
        await paginaModel.wb_comp_img.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            fk_id_file: extraData.fk_id_file,
            url_link: extraData.url_link || 'https://google.com',
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    } else if (tableComp === 'wb_comp_cards' && extraData) {
        await paginaModel.wb_comp_cards.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            titulo: extraData.titulo || LOREM.titulo.substring(0, 50),
            url_link: extraData.url_link || 'https://google.com',
            fk_id_file: extraData.fk_id_file || null,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    } else if (tableComp === 'wb_comp_titulopag' && extraData) {
        await paginaModel.wb_comp_titulopag.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            texto: extraData.texto || LOREM.titulo,
            fk_id_file: extraData.fk_id_file || null,
            fk_id_file_izq: extraData.fk_id_file_izq || null,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    } else if (tableComp === 'wb_comp_coleccion_fotografica' && extraData) {
        await paginaModel.wb_comp_coleccion_fotografica.create({
            fk_id_wb_pag_componente: comp.id_wb_pag_componente,
            fk_id_cat_wb_type_content_tag: 3, // imagen
            fk_id_cat_tag: extraData.fk_id_cat_tag,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    }
    return comp.id_wb_pag_componente;
}

/** Crea carrousel con 3 slides */
async function addCarrousel(idCol, orden, idTipoComp, idLogoFile, idPagDummy, transaction) {
    const comp = await paginaModel.componente.create({
        fk_id_wb_pag_columna: idCol,
        fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
        wb_padding: [10, 10, 10, 10],
        vigente: true,
        f_reg: new Date(),
        orden_visible: orden,
        fk_id_cat_wb_componente: idTipoComp
    }, { transaction });

    const carr = await paginaModel.wb_comp_carrousel.create({
        fk_id_wb_pag_componente: comp.id_wb_pag_componente,
        fk_id_cat_type_carrousel: 2,
        vigente: true,
        f_reg: new Date()
    }, { transaction });

    const d = LOREM.carrousel;
    for (let i = 1; i <= 3; i++) {
        await paginaModel.wb_comp_slides_carrousel.create({
            fk_id_wb_comp_carrousel: carr.id_wb_comp_carrousel,
            titulo: d.titulo,
            texto: d.texto,
            btn_text: d.btn,
            url_link: d.link,
            fk_id_wb_pagina: idPagDummy,
            fk_id_file: idLogoFile ? [String(idLogoFile)] : [],
            type_slide: 1,
            vigente: true,
            f_reg: new Date(),
            orden_visible: i
        }, { transaction });
    }
    return comp.id_wb_pag_componente;
}

/** Crea sección + columna y retorna id de columna */
async function createSeccionColumna(idPagina, ordenSec, ordenCol, transaction) {
    const sec = await paginaModel.seccion.create({
        fk_id_wb_pagina: idPagina,
        fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
        wb_margin: [10, 10, 10, 10],
        wb_padding: [10, 10, 10, 10],
        fk_id_cat_wb_width: 1,
        wb_num_col: 1,
        vigente: true,
        f_reg: new Date(),
        orden_visible: ordenSec
    }, { transaction });

    const col = await paginaModel.columna.create({
        fk_id_wb_pag_seccion: sec.id_wb_pag_seccion,
        fk_id_cat_wb_visible: [1, 2, 3, 4, 5],
        wb_padding: [10, 10, 10, 10],
        orden_visible: ordenCol,
        vigente: true,
        f_reg: new Date()
    }, { transaction });

    return col.id_wb_pag_columna;
}

/** Crea menú por defecto */
async function createDefaultMenu(idapp, idPagPrincipal, idPagSec1, idPagSec2, transaction) {
    const menu = await menuModel.menu.create({
        fk_id_sysapp: idapp,
        nombre: 'Menú principal',
        vigente: true,
        f_reg: new Date()
    }, { transaction });

    const links = [
        { nombre: 'Documentos', link_nivel: 1, fk_superior: null },
        { nombre: 'Transparencia', link_nivel: 1, fk_superior: null, fk_pagina: idPagSec1 },
        { nombre: 'Protección de Datos Personales', link_nivel: 1, fk_superior: null, fk_pagina: idPagSec2 },
    ];

    const idLinks = {};
    for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const link = await menuModel.menuLinks.create({
            fk_id_wb_menu: menu.id_wb_menu,
            nombre: l.nombre,
            link_nivel: l.link_nivel,
            fk_id_wb_menu_link_superior: l.fk_superior,
            fk_id_wb_pagina: l.fk_pagina || null,
            id_cat_type_link: 1,
            orden_visible: i + 1,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
        idLinks[l.nombre] = link.id_wb_menu_link;
    }

    const docLink = idLinks['Documentos'];
    if (docLink) {
        await menuModel.menuLinks.create({
            fk_id_wb_menu: menu.id_wb_menu,
            nombre: 'CEN',
            link_nivel: 2,
            fk_id_wb_menu_link_superior: docLink,
            id_cat_type_link: 1,
            orden_visible: 1,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
        await menuModel.menuLinks.create({
            fk_id_wb_menu: menu.id_wb_menu,
            nombre: 'CN',
            link_nivel: 2,
            fk_id_wb_menu_link_superior: docLink,
            id_cat_type_link: 1,
            orden_visible: 2,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    }
    return menu.id_wb_menu;
}

/** Crea footer por defecto */
async function createDefaultFooter(idapp, transaction) {
    // Intentar obtener el logo de la instancia (rel_sysapp_files, tipo "Logo app")
    let urlLogo = null;
    try {
        const logoFileId = await getLogoFileId(idapp);
        if (logoFileId) {
            const FilesMain = filesModel.filesMain;
            const logoFile = await FilesMain.findOne({
                where: { id_file: logoFileId },
                include: [{ association: 'storageM' }],
            });
            if (logoFile) {
                const storagePath = logoFile.storageM && logoFile.storageM.storage_path ? logoFile.storageM.storage_path : '';
                const filePath = logoFile.file_path || '';
                urlLogo = `${storagePath}${filePath}`;
            }
        }
    } catch (e) {
        console.warn('[createDefaultFooter] No se pudo resolver logo de instancia, se continúa sin url_logo:', e.message);
    }

    const footer = await footerModel.footer.create({
        fk_id_sysapp: idapp,
        nombre: 'Pie de página',
        url_logo: urlLogo,
        texto_suscripcion: LOREM.footer.texto_suscripcion,
        email_contacto: LOREM.footer.email,
        telefono_contacto: LOREM.footer.telefono,
        direccion_contacto: LOREM.footer.direccion,
        texto_copyright: LOREM.footer.copyright,
        vigente: true,
        f_reg: new Date()
    }, { transaction });

    for (let i = 0; i < 3; i++) {
        await footerModel.footerLinks.create({
            fk_id_wb_footer: footer.id_wb_footer,
            nombre: LOREM.footer.enlaces[0].nombre,
            categoria: LOREM.footer.enlaces[0].categoria,
            url_link: LOREM.footer.enlaces[0].url,
            orden_visible: i + 1,
            vigente: true,
            f_reg: new Date()
        }, { transaction });
    }
    return footer.id_wb_footer;
}

/**
 * Crea las 3 páginas template y recursos asociados
 * @param {number} idapp - ID de la instancia (sysapp)
 * @param {number} id_user - ID del usuario que crea
 * @param {object} [opts] - { transaction }
 */
async function createDefaultTemplates(idapp, id_user, opts = {}) {
    const transaction = opts.transaction || await dbConection.transaction();
    const useOwnTransaction = !opts.transaction;

    try {
        // Las categorías/tag se guardan por instancia (id_sysapp), no por tipo fijo.
        const fk_sysapp_type = idapp;

        let idImgBanner = null;
        try {
            idImgBanner = await crearFileDefault(
                '/assets/img/recursos_componentes/banner_amlo_claudia.jpg',
                'image/jpeg'
            );
        } catch {
            idImgBanner = null;
        }
        // Si no hubo archivo demo (p. ej. fallo de inserción), usar el logo de la instancia para carrusel, entradas e imagen etiquetada.
        if (!idImgBanner) {
            idImgBanner = await getLogoFileId(idapp);
        }

        const idTipoCarr = await getTipoComponenteId('wb_comp_carrousel', transaction);
        const idTipoSub = await getTipoComponenteId('wb_comp_subtitulo', transaction);
        const idTipoNot = await getTipoComponenteId('wb_comp_noticias', transaction);
        const idTipoImg = await getTipoComponenteId('wb_comp_img', transaction);
        const idTipoRed = await getTipoComponenteId('wb_comp_redes', transaction);
        const idTipoTit = await getTipoComponenteId('wb_comp_titulopag', transaction);
        const idTipoTex = await getTipoComponenteId('wb_comp_texto', transaction);
        const idTipoCard = await getTipoComponenteId('wb_comp_cards', transaction);
        const idTipoAcord = await getTipoComponenteId('wb_comp_acordeon', transaction);
        const idTipoGal = await getTipoComponenteId('wb_comp_galeria', transaction);
        const idTipoLinea = await getTipoComponenteId('wb_comp_linea', transaction);
        const idTipoCol = await getTipoComponenteId('wb_comp_coleccion_fotografica', transaction);
        const idTipoReg = await getTipoComponenteId('wb_comp_cards_regeneracion', transaction);
        const idTipoFlip = await getTipoComponenteId('wb_comp_flip', transaction);
        const idTipoPers = await getTipoComponenteId('wb_comp_personas', transaction);
        const idTipoVid = await getTipoComponenteId('wb_comp_video', transaction);

        const idTagDocumento = await getOrCreateTag('Lorem Ipsum', 1, fk_sysapp_type, transaction);
        const idTagEntrada = await getOrCreateTag('Lorem Ipsum', 2, fk_sysapp_type, transaction);
        const idTagImagen = await getOrCreateTag('Lorem Ipsum', 3, fk_sysapp_type, transaction);

        if (idImgBanner && idTagImagen) {
            try {
                const img = await paginaModel.imagen.create({
                    nombre: 'Lorem Ipsum',
                    contenido_alt: LOREM.descripcion,
                    fk_id_file: idImgBanner,
                    fk_id_user: id_user,
                    vigente: true,
                    f_reg: new Date(),
                    fk_id_sysapp: idapp
                }, { transaction });
                await paginaModel.rel_wb_tag_img.create({
                    fk_id_cat_tag: idTagImagen,
                    fk_id_wb_img: img.id_wb_img,
                    fk_id_user: id_user,
                    vigente: true,
                    f_reg: new Date()
                }, { transaction });
            } catch (errImg) {
                console.warn('[createDefaultTemplates] Imagen tag Lorem Ipsum omitida:', errImg?.message);
            }
        }

        const fPub = new Date();

        const entradas = [];
        for (let i = 1; i <= 7; i++) {
            const pag = await paginaModel.pagina.create({
                nombre_pagina: 'Lorem ipsum',
                contenido_alt: LOREM.descripcion,
                contenido: LOREM.texto + '\n\n' + LOREM.texto2,
                fk_id_file: idImgBanner,
                fk_id_cat_type_pagina: 5,
                fk_id_user: id_user,
                vigente: true,
                f_reg: new Date(),
                url_safe: 'lorem-ipsum-' + i,
                fk_id_sysapp: idapp,
                // Deben ser públicas para que el componente Noticias (solo lista publicada: true) muestre contenido al abrir la página.
                publicada: true,
                f_publicacion: fPub
            }, { transaction });
            await paginaModel.rel_wb_tag_pagina.create({
                fk_id_cat_tag: idTagEntrada,
                fk_id_wb_pagina: pag.id_wb_pagina,
                fk_id_user: id_user,
                vigente: true
            }, { transaction });
            entradas.push(pag.id_wb_pagina);
        }

        const pagPrincipal = await paginaModel.pagina.create({
            nombre_pagina: 'Inicio',
            contenido_alt: LOREM.descripcion,
            contenido: null,
            fk_id_file: null,
            fk_id_cat_type_pagina: 1,
            fk_id_user: id_user,
            vigente: true,
            f_reg: new Date(),
            url_safe: '/',
            fk_id_sysapp: idapp,
            publicada: false,
            f_publicacion: fPub
        }, { transaction });

        // Página principal: cada componente en su propia sección (como en el flujo manual)
        let secOrder = 1;
        let ord = 1;

        if (idTipoCarr) {
            const colCarr = await createSeccionColumna(pagPrincipal.id_wb_pagina, secOrder++, 1, transaction);
            await addCarrousel(colCarr, 1, idTipoCarr, idImgBanner, pagPrincipal.id_wb_pagina, transaction);
        }
        if (idTipoSub) {
            const colSub = await createSeccionColumna(pagPrincipal.id_wb_pagina, secOrder++, 1, transaction);
            await addComponente(colSub, 'wb_comp_subtitulo', 1, idTipoSub, { texto: 'Noticias' }, transaction);
        }
        if (idTipoNot) {
            const colNot = await createSeccionColumna(pagPrincipal.id_wb_pagina, secOrder++, 1, transaction);
            await addComponente(colNot, 'wb_comp_noticias', 1, idTipoNot, { fk_id_cat_tag: idTagEntrada }, transaction);
        }
        if (idTipoImg && idImgBanner) {
            const colImg = await createSeccionColumna(pagPrincipal.id_wb_pagina, secOrder++, 1, transaction);
            await addComponente(colImg, 'wb_comp_img', 1, idTipoImg, { fk_id_file: idImgBanner, url_link: 'https://google.com' }, transaction);
        }
        if (idTipoRed) {
            const colRed = await createSeccionColumna(pagPrincipal.id_wb_pagina, secOrder++, 1, transaction);
            await addComponente(colRed, 'wb_comp_redes', 1, idTipoRed, null, transaction);
        }

        const pagSec1 = await paginaModel.pagina.create({
            nombre_pagina: 'Página secundaria',
            contenido_alt: LOREM.descripcion,
            contenido: null,
            fk_id_file: idImgBanner,
            fk_id_cat_type_pagina: 2,
            fk_id_user: id_user,
            vigente: true,
            f_reg: new Date(),
            url_safe: 'pagina-secundaria',
            fk_id_sysapp: idapp,
            publicada: false,
            f_publicacion: fPub
        }, { transaction });

        // Página secundaria 1: también separa componentes por sección
        let secOrder2 = 1;
        if (idTipoTit) {
            const colTit = await createSeccionColumna(pagSec1.id_wb_pagina, secOrder2++, 1, transaction);
            await addComponente(colTit, 'wb_comp_titulopag', 1, idTipoTit, { texto: LOREM.titulo, fk_id_file: idImgBanner }, transaction);
        }
        if (idTipoSub) {
            const colSub2 = await createSeccionColumna(pagSec1.id_wb_pagina, secOrder2++, 1, transaction);
            await addComponente(colSub2, 'wb_comp_subtitulo', 1, idTipoSub, { texto: 'Lorem ipsum' }, transaction);
        }
        if (idTipoTex) {
            const colTex = await createSeccionColumna(pagSec1.id_wb_pagina, secOrder2++, 1, transaction);
            await addComponente(colTex, 'wb_comp_texto', 1, idTipoTex, { texto: LOREM.texto }, transaction);
        }
        if (idTipoCard && idImgBanner) {
            const colCard = await createSeccionColumna(pagSec1.id_wb_pagina, secOrder2++, 1, transaction);
            await addComponente(colCard, 'wb_comp_cards', 1, idTipoCard, { titulo: 'Lorem ipsum dolor sit amet consectetur', url_link: 'https://google.com', fk_id_file: idImgBanner }, transaction);
        }

        const pagSec2 = await paginaModel.pagina.create({
            nombre_pagina: 'Componentes',
            contenido_alt: LOREM.descripcion,
            contenido: null,
            fk_id_file: null,
            fk_id_cat_type_pagina: 2,
            fk_id_user: id_user,
            vigente: true,
            f_reg: new Date(),
            url_safe: 'componentes',
            fk_id_sysapp: idapp,
            publicada: false,
            f_publicacion: fPub
        }, { transaction });

        // Página secundaria 2: una sección por componente, respetando el orden del MD.
        let secOrder3 = 1;
        // 1) Subtítulo: Componentes de tipo slides
        if (idTipoSub) {
            const colSubSlides = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colSubSlides, 'wb_comp_subtitulo', 1, idTipoSub, { texto: 'Componentes de tipo slides' }, transaction);
        }
        // 2) Carrusel
        if (idTipoCarr) {
            const colCarr2 = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addCarrousel(colCarr2, 1, idTipoCarr, idImgBanner, pagSec2.id_wb_pagina, transaction);
        }
        // 3) Subtítulo: Componentes de tipo tag
        if (idTipoSub) {
            const colSubTag = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colSubTag, 'wb_comp_subtitulo', 1, idTipoSub, { texto: 'Componentes de tipo tag' }, transaction);
        }
        // 4) Colección fotográfica
        if (idTipoCol && idTagImagen) {
            const colColFoto = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colColFoto, 'wb_comp_coleccion_fotografica', 1, idTipoCol, { fk_id_cat_tag: idTagImagen }, transaction);
        }
        // 5) Noticias
        if (idTipoNot) {
            const colNot2 = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colNot2, 'wb_comp_noticias', 1, idTipoNot, { fk_id_cat_tag: idTagEntrada }, transaction);
        }
        // 6) Redes
        if (idTipoRed) {
            const colRed2 = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colRed2, 'wb_comp_redes', 1, idTipoRed, null, transaction);
        }
        // 7) Título principal
        if (idTipoTit) {
            const colTit2 = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colTit2, 'wb_comp_titulopag', 1, idTipoTit, { texto: LOREM.titulo }, transaction);
        }
        // 8) Texto
        if (idTipoTex) {
            const colTex2 = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colTex2, 'wb_comp_texto', 1, idTipoTex, { texto: LOREM.texto }, transaction);
        }
        // 9) Imagen
        if (idTipoImg && idImgBanner) {
            const colImg2 = await createSeccionColumna(pagSec2.id_wb_pagina, secOrder3++, 1, transaction);
            await addComponente(colImg2, 'wb_comp_img', 1, idTipoImg, { fk_id_file: idImgBanner, url_link: 'https://google.com' }, transaction);
        }

        await createDefaultMenu(idapp, pagPrincipal.id_wb_pagina, pagSec1.id_wb_pagina, pagSec2.id_wb_pagina, transaction);
        await createDefaultFooter(idapp, transaction);

        console.log('[createDefaultTemplates] Plantillas creadas para instancia', {
            idapp,
            paginaPrincipal: pagPrincipal.id_wb_pagina,
            paginaSecundaria1: pagSec1.id_wb_pagina,
            paginaSecundaria2: pagSec2.id_wb_pagina,
            tagDocumento: idTagDocumento,
            tagEntrada: idTagEntrada,
            tagImagen: idTagImagen,
            entradas: entradas
        });

        if (useOwnTransaction) await transaction.commit();
        return {
            success: true,
            paginaPrincipal: pagPrincipal.id_wb_pagina,
            paginaSecundaria1: pagSec1.id_wb_pagina,
            paginaSecundaria2: pagSec2.id_wb_pagina,
            entradas: entradas
        };
    } catch (err) {
        if (useOwnTransaction) await transaction.rollback();
        console.error('[createDefaultTemplates] Error:', err);
        throw err;
    }
}

module.exports = { createDefaultTemplates };
