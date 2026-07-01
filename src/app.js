require('dotenv').config();
const fs = require('fs');
const https = require('https');
const cron = require('node-cron');
const express = require('express');
const cookieParser = require('cookie-parser');
const routes = require('./routes/router');
const dashController  = require('./controllers/dashController');
const { QueryTypes  } = require('sequelize');
const path = require('path');

const secret = process.env.SECRET;
const servicePort = process.env.APP_PORT;

const opts = {
  cert: fs.readFileSync('certs/' + process.env.APP_SSL_CRT),
  key: fs.readFileSync('certs/' + process.env.APP_SSL_KEY),
};

const app = express();

// Tras nginx/terminación TLS: para que req.protocol y req.ip reflejen al cliente (útil con passkeys / URLs).
if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.set('views', 'src/views');
app.set('view engine', 'ejs');

app.use(express.static('src/public'));
// Misma base que staticGenerator.getDistDirBase: STATIC_HTML_DIST_BASE || DATA_OUTPUT_PATH || cwd del proceso
// Los HTML se escriben en {base}/dist_{slug}/app_{id}/ — antes se servía ../../dist y no coincidía con .env en dev.
const staticHtmlDistBase = process.env.STATIC_HTML_DIST_BASE
  ? path.resolve(process.env.STATIC_HTML_DIST_BASE)
  : (process.env.DATA_OUTPUT_PATH
      ? path.resolve(process.env.DATA_OUTPUT_PATH)
      : path.join(__dirname, '..'));
app.use('/dist', express.static(staticHtmlDistBase));
console.log('[static HTML] GET /dist/* sirve desde:', staticHtmlDistBase, '(ej. .../dist_morena-nacional/app_94/index.html)');

app.use(express.urlencoded({ extended: true, limit:'15mb'}));
app.use(express.json({limit:'15mb'}));
app.use(cookieParser());
// Poner aqui las variables que deben estar disponibles en todas (o una buena parte) de las vistas
app.use(function(req, res, next){
  res.locals.produccion = process.env.PRODUCCION=='true';
  res.locals.title = process.env.APP_TITLE;
  res.locals.captchaMostrar = process.env.CAPTCHA_MOSTRAR=='true';
  res.locals.captchaSitekey = process.env.CAPTCHA_SITEKEY;
  //console.log(res.locals.captchaMostrar);
  next();
});

app.use('/', routes);
app.use((req, res, next) => {
  const extnames = ['.css', '.png', '.jpg', '.jpeg', '.gif', '.js', '.woff', '.woff2', '.ttf', '.svg', '.json', '.svg', '.ico'];
  const extname = path.extname(req.url);
  if (extnames.includes(extname)) {
    return next();
  }
  dashController.inicio(req, res);
});

const event = new Date(Date.now());
//  console.log(
//   event.toLocaleString('es-MX', { timeZone: 'UTC', dateStyle: 'short' })
//);
const dbConection = require('./config/postgressdb');
const cat_type_usersModel = require('../src/models/cat_type_users');

https.createServer(opts, app).listen(servicePort, async function (req, res) {
  global.catalogos = {};

  try {
    const cat_type_users = await cat_type_usersModel.findAll({where:{vigente:true},order:[['id_cat_type_users', 'ASC']]});
    if (!cat_type_users) throw new Error('No existe el cátalogo de tipos de usuarios');
    global.catalogos.cat_type_users = cat_type_users.map(e=>e.dataValues);

    const cat_entidad_federativa = await dbConection.query(`SELECT * FROM cat_estados ;`, {
      type: QueryTypes.SELECT,
    })
    if (!cat_entidad_federativa) throw new Error('No existe el cátalogo de entidad federativa');
    global.catalogos.cat_entidad_federativa = cat_entidad_federativa

    const cat_apps_activas = await dbConection.query( //se quitó app_logo
        `SELECT id_sysapp,sysapp_name,fk_id_sysapp_type, app_legend,app_desc,key_sysapp,urluri,app_favicon 
        FROM sysapp
        left join rel_sysapp_group on fk_id_sysapp=id_sysapp
        where  sysapp.vigente is true --and publicada is true
        and fk_id_sysapp_group=$1`, {
      type: QueryTypes.SELECT,
      bind: [ process.env.GRUPO_APLICACIONES]
    })



    if (!cat_apps_activas) throw new Error('No hay apps públicas activas');
    global.catalogos.cat_apps_activas = cat_apps_activas


    // console.log(`App: ${global.catalogos.cat_apps_activas[0].urluri}`);

    console.log(`Server started at port: ${servicePort}`);
    console.log(`https://localhost:${servicePort}`);

    const { runSync } = require('./jobs/syncGscMetrics');
    cron.schedule('0 3 * * *', function () {
      runSync().catch((e) => console.error('[syncGscMetrics]', e));
    }, { timezone: 'America/Mexico_City' });
    console.log('Cron diario de métricas GSC: 03:00 America/Mexico_City');
  } catch (e) {
    console.log(e.message)
  }
});
