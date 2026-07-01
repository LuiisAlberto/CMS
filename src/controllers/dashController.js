const jwt = require('jsonwebtoken');
const userModel = require('../models/users');
const cat_type_usersModel = require('../models/cat_type_users');
const {promisify} = require('util');
const WS = require('../util/WebServices')
// const { Sequelize, DataTypes } = require('sequelize');
// const sub_moduloModel = require('../models/sub_modulo');
const CatalogModel = require('../models/CatalogModel');
const { getPreferredUsersInstanciaAppId, isUsersInstanciaSubmod } = require('../util/dedupeUsersInstanciaMenu');
const { applyResponsableMenuFilterIfNeeded } = require('../util/instanceScope');
const {pagina,seccion,columna,componente} = require('../models/paginasModel');
const util = require('util');
const fs = require('fs');
const pathModule = require('path');
const staticGenerator = require('../util/staticGenerator');


async function inicio(req, res) {
  const { error } = req.query;
  if (error) {
      const msg = error === 'reiniciando' ? 'El sistema se está reiniciando. Por favor, recargue la página en unos segundos.' : (error || 'Sesión expirada.');
      return res.render('publics/error', { alert: false, error: msg });
  }

  // 1) Host + path sin querystring, para no ensuciar los segmentos
  const host = req.get('host');          // ej: "localhost:3000"
  const path = req.path || '/';          // ej: "/miapp/inicio"
  let urluri = host + path;              // ej: "localhost:3000/miapp/inicio"

  // Partimos host + path
  let arr_uri = urluri.split('/');
  let base = arr_uri[0];                 // host

  // Helper para normalizar URLs (quitamos http(s) y slash final)
  const normalizeUrl = (u = '') =>
    u.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // Segmentos reales de la ruta (sin host, sin vacíos)
  const segmentos = arr_uri.slice(1).filter(Boolean); // ['miapp'], ['miapp','inicio'], ['miapp','entradas','nota-x']
  const app = segmentos[0] || '';
  const paginaSegment = segmentos[1] || '';
  const parametro = segmentos[2] || '';

  // 2) Detectar type_uri (solo manejamos 1, 2 y 5)
  // /app              -> type 1  (home)
  // /app/slug         -> type 2  (página normal)
  // /app/slug/slug2   -> type 5  (entrada/noticia)
  let type_uri;
  if (segmentos.length >= 3) {
    type_uri = 5;
  } else if (segmentos.length === 2) {
    type_uri = 2;
  } else {
    type_uri = 1;
  }

  let pagina_uri = paginaSegment || '/';

  // Para rutas de entrada: /app/entradas/slug -> pagina_uri debe ser 'entradas/slug' para coincidir con el HTML estático
  if (type_uri === 5 && parametro) {
    pagina_uri = (paginaSegment && paginaSegment.toLowerCase() === 'entradas') ? 'entradas/' + parametro : parametro;
  }

  // url base de la app: host + /app
  urluri = base + '/' + app;                           // ej: "localhost:3000/miapp"
  const urluriNorm = normalizeUrl(urluri);             // ej: "localhost:3000/miapp"
  const adminBaseNorm = normalizeUrl(process.env.APP_BASE_URL_ADMIN || '');
  
  // Extraer la base del admin (sin el /admin)
  let adminBaseHost = '';
  if (adminBaseNorm) {
    // Si adminBaseNorm es "localhost:3000/admin", extraer "localhost:3000"
    const adminParts = adminBaseNorm.split('/');
    adminBaseHost = adminParts[0]; // El host sin el path
  } else {
    // Si no está configurado APP_BASE_URL_ADMIN, usar el host actual como base del admin
    adminBaseHost = normalizeUrl(base);
  }

  try {
    // 3) Resolver app activa
    let arr_url = [];
    let objapp = null;

    if (global.catalogos?.cat_apps_activas && (Array.isArray(global.catalogos.cat_apps_activas) || typeof global.catalogos.cat_apps_activas === 'object')) {
      const apps = Array.isArray(global.catalogos.cat_apps_activas) ? global.catalogos.cat_apps_activas : Object.values(global.catalogos.cat_apps_activas);
      apps.forEach(appCfg => {
        const appUrlNorm = normalizeUrl(appCfg.urluri || '');
        arr_url.push(appUrlNorm);

        if (appUrlNorm === urluriNorm) {
          objapp = appCfg;
        }
      });
    } else {
      return res.status(503).render('publics/error', {
        alert: false,
        error: 'El sistema se está reiniciando. Por favor, recargue la página en unos segundos.'
      });
    }

    // =========================
    // 4) RAMA ADMIN
    // =========================
    // Si la ruta es "/" (root) y no hay app pública, redirigir a /admin
    // También verificar si la URL normalizada del host coincide con la base del admin
    const hostNorm = normalizeUrl(base);
    if ((path === '/' || urluriNorm === hostNorm) && !objapp && adminBaseHost && hostNorm === adminBaseHost) {
      return res.redirect('/admin');
    }
    
    if (adminBaseNorm && urluriNorm === adminBaseNorm) {
      try {
        if (!req.cookies[process.env.APP_COOKIE_NAME]) {
          return res.render('index', { alert: false, captchaMostrar: process.env.CAPTCHA_MOSTRAR=='true' });
        }

        const decoded = await promisify(jwt.verify)(
          req.cookies[process.env.APP_COOKIE_NAME],
          process.env.SECRET
        );

        if (!decoded.id_user && decoded.id_group !== process.env.GRUPO_APLICACIONES) {
          return res.render('index', { alert: false, captchaMostrar: process.env.CAPTCHA_MOSTRAR=='true' });
        }

        let data = await userModel.findOne({ where: { id_user: decoded.id_user } });
        req.usdata = data.dataValues;
        req.usdata.type_user = global.catalogos.cat_type_users
          .find(e => e.id_cat_type_users == data.fk_id_cat_type_users)
          .type_user;

        let modulos_pre = await CatalogModel.getPermisos(data.id_user);
        let arr_modulos = {};

        for (let i = 0; i < modulos_pre.length; i++) {
          const sysappId = modulos_pre[i].id_sysapp;
          const sysmodId = modulos_pre[i].id_sysmod;
          const syssubmodId = modulos_pre[i].id_syssubmod;

          // Crear app si no existe
          if (!arr_modulos[sysappId]) {
            const idcypher = jwt.sign(
              {
                idapp: sysappId,
                date_comp: new Date()
              },
              process.env.SECRET
            );
            arr_modulos[sysappId] = {
              app_name: modulos_pre[i].app_legend,
              id: sysappId,
              id_sysapp_type: modulos_pre[i].id_sysapp_type,
              mod_count: 0,
              appcypher: idcypher,
              modulos: {}
            };
          }

          // Crear módulo si no existe
          if (!arr_modulos[sysappId].modulos[sysmodId]) {
            arr_modulos[sysappId].mod_count++;
            arr_modulos[sysappId].modulos[sysmodId] = {
              id_mod: sysmodId,
              mod_legend: modulos_pre[i].modulo_legend,
              micon: modulos_pre[i].micon,
              submod_count: 0,
              submodulos: {}
            };
          }

          // Crear submódulo si no existe
          if (!arr_modulos[sysappId].modulos[sysmodId].submodulos[syssubmodId]) {
            arr_modulos[sysappId].modulos[sysmodId].submod_count++;
            arr_modulos[sysappId].modulos[sysmodId].submodulos[syssubmodId] = {
              id_syssubmod: syssubmodId,
              legend: modulos_pre[i].submodulo_legend,
              archivo: modulos_pre[i].archivo,
              smicon: modulos_pre[i].smicon
            };
          }
        }

        arr_modulos = await applyResponsableMenuFilterIfNeeded(arr_modulos, req.usdata);
        req.usdata.usersInstanciaMenuAppId = getPreferredUsersInstanciaAppId(arr_modulos);

        // Ajuste de leyendas cuando solo hay 1 módulo / submódulo
        Object.values(arr_modulos).forEach(appCfg => {
          if (appCfg.mod_count === 1) {
            Object.values(appCfg.modulos).forEach(modulo => {
              if (modulo.submod_count === 1) {
                Object.values(modulo.submodulos).forEach(submod => {
                  /* users-instancia debe quedar bajo la carpeta del sysmod (p. ej. Configuración global), no como enlace al mismo nivel que otros módulos */
                  if (isUsersInstanciaSubmod(submod)) return;
                  arr_modulos[appCfg.id].legend = submod.legend;
                  arr_modulos[appCfg.id].archivo = submod.archivo;
                  arr_modulos[appCfg.id].smicon = submod.smicon;
                  arr_modulos[appCfg.id].id_syssubmod = submod.id_syssubmod;
                });
              }
            });
          } else {
            Object.values(appCfg.modulos).forEach(modulo => {
              if (modulo.submod_count === 1) {
                Object.values(modulo.submodulos).forEach(submod => {
                  if (isUsersInstanciaSubmod(submod)) return;
                  arr_modulos[appCfg.id].modulos[modulo.id_mod].legend = submod.legend;
                  arr_modulos[appCfg.id].modulos[modulo.id_mod].archivo = submod.archivo;
                  arr_modulos[appCfg.id].modulos[modulo.id_mod].smicon = submod.smicon;
                  arr_modulos[appCfg.id].modulos[modulo.id_mod].id_syssubmod = submod.id_syssubmod;
                });
              }
            });
          }
        });

        req.usdata.modulos = arr_modulos;
        if (process.env.ACTIVE_DIRECTORY != 'true' && req.usdata.campass == false) {
          return res.render('psw');
        }

        return res.render('inicio', {
          alert: false,
          alertTitle: 'Bienvenido',
          alertMessage: 'Ingreso correcto',
          ...req.usdata,
          ultimaActualizacion: new Date().toLocaleString('es-MX')
        });
      } catch (error) {
        console.error(error);
        return res.render('index', { alert: false, captchaMostrar: process.env.CAPTCHA_MOSTRAR=='true' });
      }
    }

    // =========================
    // 5) RAMA PÚBLICA (web builder)
    // Las páginas publicadas se sirven SOLO desde el HTML estático en dist.
    // No se usa EJS ni datos de la BD para el contenido público.
    // =========================

    // Si la URL no pertenece a ninguna app activa → 404 / 405
    if (!arr_url.includes(urluriNorm) || !objapp) {
      if (req.method === 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('Petición no permitida 1');
      }
      return res.render('publics/404', { alert: false, captchaMostrar: process.env.CAPTCHA_MOSTRAR=='true' });
    }

    // Normalizar URI para buscar en el mapping de dist (ruta creada de la página)
    const normalizedUri = (type_uri === 1 && (!pagina_uri || pagina_uri === '/')) ? '/' : (pagina_uri || '/');
    let htmlFileName = staticGenerator.buscarHTMLEstatico(objapp.id_sysapp, null, normalizedUri);
    // Home puede estar guardado como '/' o como 'inicio'
    if (!htmlFileName && type_uri === 1) {
      htmlFileName = staticGenerator.buscarHTMLEstatico(objapp.id_sysapp, null, 'inicio');
    }

    // No hay HTML estático: comprobar si la página existe (solo para 404 adecuado)
    let paginas = await pagina.getDataPagina(objapp.id_sysapp, pagina_uri, type_uri);
    let objpagina = paginas && paginas.length ? paginas[0] : null;

    if (!objpagina && type_uri === 2) {
      const paginasEntrada = await pagina.getDataPagina(objapp.id_sysapp, pagina_uri, 5);
      if (paginasEntrada && paginasEntrada.length) objpagina = paginasEntrada[0];
    }
    if (!objpagina && type_uri === 1) {
      const homePages = await pagina.getDataPagina(objapp.id_sysapp, 'inicio', 2);
      if (homePages && homePages.length) objpagina = homePages[0];
    }

    if (!objpagina) {
      return res.render('publics/404', { alert: false, captchaMostrar: process.env.CAPTCHA_MOSTRAR=='true' });
    }

    // Regla de visualización:
    // - publicada=true  -> servir HTML estático (si existe)
    // - publicada=false -> render dinámico desde BD (preview de contenido)
    const rawPublished = (objpagina && objpagina.publicada !== undefined)
      ? objpagina.publicada
      : (objpagina && objpagina.dataValues ? objpagina.dataValues.publicada : null);
    const isPublished = rawPublished === true || rawPublished === 1 || rawPublished === '1' || rawPublished === 't';

    // Si la página está publicada y existe HTML estático en dist, servirlo.
    // (Importante: antes se servía aunque la página no estuviera publicada, causando HTML "viejo".)
    if (htmlFileName) {
      const distDir = staticGenerator.getDistDirBase(objapp.id_sysapp, objapp);
      const staticFilePath = pathModule.join(distDir, `app_${objapp.id_sysapp}`, htmlFileName);
      if (fs.existsSync(staticFilePath)) {
        const staticHTML = fs.readFileSync(staticFilePath, 'utf8');
        return res.type('html').send(staticHTML);
      }
    }

    if (isPublished) {
      // Publicada pero sin HTML estático: no caer a BD para evitar inconsistencias de publicación.
      return res.status(503).render('publics/error', {
        alert: false,
        error: 'El contenido estático de esta página no está disponible. Regenera la publicación desde el CMS.'
      });
    }

    // No publicada: permitir vista dinámica para revisión/preview desde BD.
    return res.render('publics/index', {
      datapagina: objpagina,
      dataapp: objapp
    });
  } catch (e) {
    console.error(e);
    return res.render('publics/error', { alert: false, captchaMostrar: process.env.CAPTCHA_MOSTRAR=='true' });
  }
}

async function savecdr(req,res){
  try {
    const token = req.cookies[process.env.APP_COOKIE_NAME];
    const usuario = jwt.verify(token, process.env.SECRET);
    const id_user = usuario.id_user;

    const blobServiceClient = BlobServiceClient.fromConnectionString(
        process.env.BLOB_CONNECTION
    );
    const containerName = process.env.BLOB_CONTAINER;
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const images = ['img_selfie'];
    const blobPath = 'persona/' + id_user;
    let newFile;
    let tipo_doc = 0;

    for (const imgField of images) {
      const image = req.files[imgField][0];

      const fileSizeInBytes = image.size;
      const fileType = image.mimetype;
      const fileExtension = image.originalname.split('.').pop();
      switch (imgField) {
        case 'img_selfie':
          tipo_doc = 1;
          break;
      }

      const blobName = blobPath + '/' + `${Date.now()}-${imgField}-${image.originalname}`;

      newFile = new archivosModel({
        fk_id_user: id_user,
        fk_id_tipo_doc: tipo_doc,
        nombre_archivo: blobName,
        tamanio_archivo: fileSizeInBytes,
        tipo:fileType,
        fk_id_cat_tipo_archivo: tipo_doc,
      });

      resulFile = await newFile.save();

      if (resulFile) {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.upload(image.buffer, image.size);
      }

      res.json({ success: true, msg: 'Éxito al guardar' });
    }

  } catch (error) {
    res.json({ success: false, msg: 'Intente más tarde' });
  }
}

module.exports = {
  inicio,
  savecdr,
};
  