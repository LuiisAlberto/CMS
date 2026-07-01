require('dotenv').config()
      const sgMail = require('@sendgrid/mail');
      const fs = require('fs');
const path = require('path')
const {promisify} = require("util");
const jwt = require("jsonwebtoken");
const { Storage } = require("@google-cloud/storage");
const storage = new Storage({
  projectId: process.env.BUCKET_NAME,
  keyFilename: `certs/${process.env.BUCKET_KEY}`
});

/**
 * @abstract El proposito de esta constante es para no declarar una y otra vez un formateador de fecha larga.
 * En realidad no es necesaario, sin embargo puede servie como ejemplo para otros formateadores
 */
const FormateadorDeFechas = new Intl.DateTimeFormat('es-Mx',{ day: 'numeric', month: 'long', year: 'numeric' });

function envValue(value) {
  return (value ?? '').trim();
}

function hasSendgridConfig() {
  return envValue(process.env.MAIL_APIKEY_SENDGRID) !== '';
}

/**
 * Origen del envío: `MAIL_TRANSPORT=smtp|sendgrid|azure` (recomendado si conviven varias configs).
 * Si no se define: SendGrid si hay `MAIL_APIKEY_SENDGRID`, si no Azure si `MAILER_USER` es el marcador,
 * si no SMTP.
 */
function getMailTransport() {
  const t = envValue(process.env.MAIL_TRANSPORT).toLowerCase();
  if (t === 'smtp' || t === 'mailgun' || t === 'nodemailer') return 'smtp';
  if (t === 'sendgrid') return 'sendgrid';
  if (t === 'azure') return 'azure';
  if (hasSendgridConfig()) return 'sendgrid';
  if (envValue(process.env.MAILER_USER) === 'azure/communication-email') return 'azure';
  return 'smtp';
}

function normalizeSendgridAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return undefined;

  return attachments.map(att => {
    let content = att.content;
    if (att.path && !content) {
      content = fs.readFileSync(att.path).toString('base64');
    } else if (Buffer.isBuffer(content)) {
      content = content.toString('base64');
    }

    return {
      content,
      filename: att.filename || (att.path ? path.basename(att.path) : undefined),
      type: att.type || att.contentType || 'application/octet-stream',
      disposition: att.disposition || (att.cid || att.content_id ? 'inline' : 'attachment'),
      content_id: att.cid || att.content_id
    };
  });
}

function normalizeMailerAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return undefined;

  return attachments.map(att => {
    const mailerAttachment = {
      filename: att.filename || (att.path ? path.basename(att.path) : undefined),
      content: att.content,
      path: att.path,
      contentType: att.contentType || att.type,
      disposition: att.disposition,
    };

    if (att.content_id) mailerAttachment.cid = att.content_id;
    if (att.cid) mailerAttachment.cid = att.cid;
    if (typeof att.content === 'string' && !att.path) mailerAttachment.encoding = 'base64';

    return mailerAttachment;
  });
}
function genCode(){
  const caracteresPermitidos = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';//0, 1, I, L, Ñ, O: No están dado a que pueden generar confuciones
  let cadenaAleatoria = '';

  for (let i = 0; i < 5; i++) {
    const caracterAleatorio = caracteresPermitidos.charAt(
      Math.floor(Math.random() * caracteresPermitidos.length)
    );
    cadenaAleatoria += caracterAleatorio;
  }

  return cadenaAleatoria;
}
/**
 * 
 * @param {string} fechaNac 
 * @returns {number}
 */
function calcularEdad(fechaNac){
  
  const [day, month, year] = fechaNac.split('/').map(Number);
  if (isNaN(day) || isNaN(month) || isNaN(year)) {
      throw new Error('Formato de fecha no válido.');
      //return 0;
  }

  const monthM1 = month - 1;

  const birthDate = new Date(year, monthM1, day);

  if (isNaN(birthDate.getTime())) {
      throw new Error('Error en calculo de Edad: isNaN(birthDate.getTime())==true ');
  }
  const currentDate = new Date();
  
  const edad = currentDate.getFullYear() - birthDate.getFullYear();
  if (
    birthDate.getMonth() > currentDate.getMonth() ||
    (birthDate.getMonth() === currentDate.getMonth() &&
      birthDate.getDate() > currentDate.getDate())
  ) {
    return edad - 1;
  } else {
    return edad;
  }
}
/**
 * 
 * @param {*} message Mensaje a Enviar
 * @returns 
 */
async function messageTelegram(message){

  let response = { 'code': 200, message: null, model: null }

  try {
      const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
      const BOT_GROUP_ID = process.env.TELEGRAM_BOT_GROUP_ID;
      const TelegramBot = require('node-telegram-bot-api');
      const bot = new TelegramBot(BOT_TOKEN/*, { polling: true }*/);

      let res = await bot.sendMessage(BOT_GROUP_ID, message);
      response.code = 200;

  } catch (e) {
      console.log(e);
      response.code = 500;
      response.message = JSON.stringify(e);
  }

  return response;
}

/**
 * @param {Object} data
 * data = {to,to_name,subject,body [,isHTml] [,attachments] }
 * @param {String} data.to direccion del correo destinatario
 * @param {String} data.to_name nombre del correo destinatario
 * @param {String} data.subject asunto del correo
 * @param {String} data.body cuerpo del correo
 * @param {boolean} data.isHTml bandera para tratar al cuerpo como html
 * @param {Array} data.attachments Arreglo con los attachments
 */
async function enviarEmail(data){
  if(
    (data?.to??'')==''
    || (data?.to_name??'')==''
    || (data?.subject??'')==''
    || (data?.body??'')==''
  ) throw new Error('Datos requeridos para Email no ingresados');

  let response = { success:false, data:null, msg:'', error:null };

  if (process.env.MAIL_ACTIVE != 'true') {
    console.warn('⚠️  MAIL_ACTIVE no está activado. El correo no se enviará.');
    response.success = false;
    response.msg = 'Servicio de correo no activado (MAIL_ACTIVE != true)';
    return response;
  }

  const destinatarioFinal =
    process.env.MAIL_TEST == 'true' && envValue(process.env.MAIL_TEST_ADDRESS)
      ? envValue(process.env.MAIL_TEST_ADDRESS)
      : data.to;

  if (process.env.MAIL_TEST == 'true' && envValue(process.env.MAIL_TEST_ADDRESS)) {
    console.log('🧪 Modo TEST activo - Redirigiendo correo a:', process.env.MAIL_TEST_ADDRESS);
  }

  try{
    const transport = getMailTransport();

    if(transport === 'sendgrid'){
      if(!envValue(process.env.MAIL_ORIGIN) && !envValue(process.env.MAILER_FROM_ADRESS)){
        const errorMsg = 'Error en la configuración de SendGrid. Falta MAIL_ORIGIN o MAILER_FROM_ADRESS';
        console.error('❌', errorMsg);
        throw new Error(errorMsg);
      }

      sgMail.setApiKey(process.env.MAIL_APIKEY_SENDGRID);

      const mailObject = {
        to: destinatarioFinal,
        from: {
          email: envValue(process.env.MAIL_ORIGIN) || envValue(process.env.MAILER_FROM_ADRESS),
          name: envValue(process.env.MAILER_FROM_NAME) || undefined,
        },
        subject: data.subject
      };

      if(data?.isHTml==true || data?.isHTml==undefined){
        mailObject.html = data.body;
      } else {
        mailObject.text = data.body;
      }

      if(data.attachments && Array.isArray(data.attachments) && data.attachments.length > 0){
        mailObject.attachments = normalizeSendgridAttachments(data.attachments);
      }

      const responseSendGrid = await sgMail.send(mailObject);
      
      console.log('✅ Correo enviado exitosamente vía SendGrid');
      response.success = true;
      response.data = { type:'sendgrid', responseData : responseSendGrid };

    } else if(transport === 'azure'){
      if(
        envValue(process.env.MAILER_HOST)==''
        || envValue(process.env.MAILER_PASS)==''
        || envValue(process.env.MAILER_FROM_ADRESS)==''
      ) throw new Error('Error en la configuración de Azure (MAILER_HOST, MAILER_PASS, MAILER_FROM_ADRESS)');

      const { EmailClient } = require("@azure/communication-email");
      const connectionString = `endpoint=https://${process.env.MAILER_HOST}/;accesskey=${process.env.MAILER_PASS}`
      const emailClient = new EmailClient(connectionString);
      
      const mailObject = {
        senderAddress: process.env.MAILER_FROM_ADRESS,
        content: {
          subject: data.subject,
        },
        recipients: {
          to: [
            {
              address: destinatarioFinal,
            },
          ],
        },
      };

      mailObject.content[data.isHTml?'html':'plainText'] = data.body;
      const poller = await emailClient.beginSend(mailObject);
      const poolResponse = await poller.pollUntilDone()
      
      response.success = true;
      response.data = { type:'azure', responseData : poolResponse };

    } else {
      console.log('📧 Usando SMTP como proveedor de correo');
      if(
        envValue(process.env.MAILER_HOST)==''
        || envValue(process.env.MAILER_USER)==''
        || envValue(process.env.MAILER_PASS)==''
        || envValue(process.env.MAILER_FROM_NAME)==''
        || envValue(process.env.MAILER_FROM_ADRESS)==''
      ) {
        const errorMsg = 'Error en la configuración de SMTP. Faltan variables requeridas.';
        console.error('❌', errorMsg);
        throw new Error(errorMsg);
      }

      const nodemailer = require('nodemailer');
      const mailObject = {
        from: '"'+process.env.MAILER_FROM_NAME+'" <'+process.env.MAILER_FROM_ADRESS+'>',
        to: '"'+data.to_name+'" <'+destinatarioFinal+'>',
        subject: data.subject
      };
      
      if(data?.isHTml==true){
        mailObject.html=data.body
      } else {
        mailObject.text = data.body;
      }
      
      if(data.attachments != undefined && data?.attachments != null && Array.isArray(data.attachments)){
        mailObject.attachments=normalizeMailerAttachments(data.attachments)
      }
      
      const transporter = nodemailer.createTransport({
        host: process.env.MAILER_HOST,
        port: process.env.MAILER_PORT,
        secure: process.env.MAILER_PORT=='465',
        auth: {
          user: process.env.MAILER_USER,
          pass: process.env.MAILER_PASS,
        },
      });

      const responseSMTP = await transporter.sendMail(mailObject)
      
      console.log('✅ Correo enviado exitosamente vía SMTP');
      response.success = true;
      response.data = { type:'smtp', responseData : responseSMTP };
    }

  } catch(error){
    console.error('❌ Error al enviar correo:', error.message);
    console.error('❌ Stack trace:', error.stack);
    response.success = false
    response.msg = error.message;
    let errorType = 'smtp';
    try {
      const t = getMailTransport();
      if (t === 'azure') errorType = 'azure';
      if (t === 'sendgrid') errorType = 'sendgrid';
    } catch (_) {
      /* ignore */
    }
    
    response.error = {
      type: errorType,
      errorData: error
    }
  }
  
  return response;
}



/**
 * @abstract Función para el envio de SMS con la api de SMS Masivos
 * @param {string} message Mensaje a enviar
 * @param {number} number Numero destinatario
 * @param {number} sandbox 1 para pruebas 0 para envio real, por defecto 0preparado para producción
 */
async function enviarSMS(message,number,sandbox=0){
  const apikey = process.env.SMSMASIVOS_APIKEY;
  if(apikey=='') return {
      success: false,
      error: 'No apikey'
  }
  const url ='https://api.smsmasivos.com.mx/sms/send';
  const infoRequest = {
      message: message,
      numbers: number,
      country_code: '52',
      sender: 'IMSS-BIENESTAR',
      sandbox: sandbox
  };
  return fetch(
      url,
      {
          method:'POST',
          headers: { apikey: apikey },
          body: (new URLSearchParams(infoRequest)).toString()
      }
  ).then(async (response)=>{
      if( response.ok && response.status==200){
          return await response.json();
      } else{
          return {
              success: false,
              message: 'Mensaje no enviado',
              status: response.status
          }
      }
  }).catch(error=>{
      console.error('--->>>sms.enviarSMS');
      console.error(error);
      console.error('sms.enviarSMS<<<---');
      return {
          success: false,
          message: 'Mensaje no enviado',
          error: error
      }
  });
}

function compareDates(date) {
    if (!date) return false;
    
    try {
        const date_comp = new Date(date);
        const date_now = new Date();

        // Verificar que la fecha sea válida
        if (isNaN(date_comp.getTime())) {
            console.error('compareDates: fecha inválida', date);
            return false;
        }

        // Comparar usando UTC para evitar problemas de zona horaria
        const compYear = date_comp.getUTCFullYear();
        const compMonth = date_comp.getUTCMonth();
        const compDate = date_comp.getUTCDate();
        
        const nowYear = date_now.getUTCFullYear();
        const nowMonth = date_now.getUTCMonth();
        const nowDate = date_now.getUTCDate();

        return compYear === nowYear &&
            compMonth === nowMonth &&
            compDate === nowDate;
    } catch (error) {
        console.error('Error en compareDates:', error);
        return false;
    }
}

async function paginate(funcion, reload, page, tpages, adjacents) {
  const prevlabel = "&lsaquo;";
  const nextlabel = "&rsaquo;";
  let out = '<nav><ul class="pagination justify-content-center">';

  // previous label
  if (page === 1) {
      out += "<li class='page-item disabled'><span><a class='page-link'>" + prevlabel + "</a></span></li>";
  } else if (page === 2) {
      out += "<li class='page-item'><span><a class='page-link' href='javascript:void(0);' onclick='" + funcion + "(1)'>" + prevlabel + "</a></span></li>";
  } else {
      out += "<li class='page-item'><span><a class='page-link' href='javascript:void(0);' onclick='" + funcion + "(" + (page - 1) + ")'>" + prevlabel + "</a></span></li>";
  }

  // first label
  if (page > (adjacents + 1)) {
      out += "<li class='page-item'><a class='page-link' href='javascript:void(0);' onclick='" + funcion + "(1)'>1</a></li>";
  }
  // interval
  if (page > (adjacents + 2)) {
      out += "<li class='page-item'><a class='page-link'>...</a></li>";
  }

  // pages
  const pmin = (page > adjacents) ? (page - adjacents) : 1;
  const pmax = (page < (tpages - adjacents)) ? (page + adjacents) : tpages;
  for (let i = pmin; i <= pmax; i++) {
      if (i === page) {
          out += "<li class='page-item active'><a class='page-link'>" + i + "</a></li>";
      } else if (i === 1) {
          out += "<li class='page-item'><a class='page-link' href='javascript:void(0);' onclick='" + funcion + "(1)'>" + i + "</a></li>";
      } else {
          out += "<li class='page-item'><a class='page-link' href='javascript:void(0);' onclick='" + funcion + "(" + i + ")'>" + i + "</a></li>";
      }
  }

  // interval
  if (page < (tpages - adjacents - 1)) {
      out += "<li class='page-item'><a class='page-link'>...</a></li>";
  }

  // last
  if (page < (tpages - adjacents)) {
      out += "<li class='page-item'><a class='page-link' href='javascript:void(0);' onclick='" + funcion + "(" + tpages + ")'>" + tpages + "</a></li>";
  }

  // next
  if (page < tpages) {
      out += "<li class='page-item'><span><a class='page-link' href='javascript:void(0);' onclick='" + funcion + "(" + (page + 1) + ")'>" + nextlabel + "</a></span></li>";
  } else {
      out += "<li class='page-item disabled'><span><a class='page-link'>" + nextlabel + "</a></span></li>";
  }

  out += "</ul></nav>";
  return out;
}

function limpiarObjetoSequelize(obj) {
    if (!obj) return obj;

    if (obj?.dataValues) {
        obj = obj.dataValues;
    }

    if (Array.isArray(obj)) {
        return obj.map(elemento => limpiarObjetoSequelize(elemento));
    }

    if (typeof obj === "object" && obj !== null) {
        for (const key in obj) {
            obj[key] = limpiarObjetoSequelize(obj[key]);
        }
    }
    return obj;
}

async function decodificarDatos(codigoJWT){
  const decoded   = await promisify(jwt.verify)(codigoJWT, process.env.SECRET);
  if (!decoded)   return false;
  let comparedates= compareDates(decoded.date_comp);
  if(!comparedates) return false;

  return decoded;
}

async function downloadImage(bucketName, filePath) {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);
    return await file.download();
  } catch (error) {
    console.error("Error al descargar la imagen:", error.message);
    throw error;
  }
}

/**
 * Al concatenar storage_path + file_path, si el primero termina en /cdn/ y el segundo
 * empieza con cdn/, queda /cdn/cdn/ y el objeto en el bucket no existe (NoSuchKey).
 * Normaliza a un solo segmento /cdn/.
 */
function normalizeConcatenatedMediaUrl(url) {
  if (url == null || typeof url !== 'string') return url;
  let out = url;
  while (out.includes('/cdn/cdn/')) {
    out = out.replace(/\/cdn\/cdn\//g, '/cdn/');
  }
  return out;
}

/**
 * CURP: base de 18 caracteres con tolerancia de 0-2 alfanuméricos extra.
 * Rechaza correos u otras cadenas que no cumplan el patrón.
 * Misma regla base que en usuarios (usuariosAcciones / NuevoUsuarioValidarCurp).
 */
function isValidCurpFormat(curpRaw) {
  if (curpRaw == null || typeof curpRaw !== 'string') return false;
  const s = String(curpRaw).trim().toUpperCase();
  if (s.length < 18 || s.length > 20) return false;
  if (s.includes('@')) return false;
  return /^[A-Z]{4}\d{6}[A-Z]{6}[A-Z0-9]\d[A-Z0-9]{0,2}$/.test(s);
}

module.exports = {
  genCode,
  calcularEdad,
  messageTelegram,
  enviarSMS,
  enviarEmail,
  FormateadorDeFechas,
  compareDates,
  paginate,
    limpiarObjetoSequelize,
  decodificarDatos,
  downloadImage,
  normalizeConcatenatedMediaUrl,
  isValidCurpFormat,
}
