const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const userModel = require('../models/users');
const ActiveDirectory = require('activedirectory');
const { Op, fn, col, where } = require('sequelize');

async function findLoginUser(loginInput) {
  const normalized = String(loginInput || '').trim().toLowerCase();
  if (!normalized) return null;

  return userModel.findOne({
    where: {
      [Op.or]: [
        where(fn('lower', fn('btrim', col('uname'))), normalized),
        where(fn('lower', fn('btrim', col('email'))), normalized),
      ],
    },
  });
}

async function login(req,res){
  try {
    if (process.env.ACTIVE_DIRECTORY == 'true') {
      //console.log('login de modulo ad activada');
      return apLoginAD(req, res);
    } else {
      //console.log('login de modulo ad no activada');
      return apLoginNoAd(req, res);
    }
  } catch (error){
    console.error(error);
    return res.status(500).json({ success: false, error: 1, message: 'Error' });
  }
}

async function apLoginNoAd(req, res){
  try {
    const user = req.body.user.trim().toLowerCase();
    const pword = req.body.pass;
    const usePasskey = req.body.usePasskey === 'true';
    // comentado, pero disponible para usos futuros
    // const curp = req.body.curp.trim();
    const recaptcha = req.body['g-recaptcha-response'] ?? '';
    
    // Si se está usando passkey, no validar contraseña
    if (!usePasskey && (!user || !pword)) {
      return res.json({ success: false , msg: 'Ingrese usuario y contraseña'});
    }
    if (usePasskey && !user) {
      return res.json({ success: false , msg: 'Ingrese usuario'});
    }
    if (process.env.CAPTCHA_MOSTRAR == 'true' && recaptcha == ''){
      return res.json({ success: false , msg: 'Captcha Incorrecto'});
    }
    if (process.env.CAPTCHA_MOSTRAR == 'true') {
      const responseCaptcha = await (await fetch(
        'https://www.google.com/recaptcha/api/siteverify',
        {
          method: 'POST',
          body: 'secret='+process.env.CAPTCHA_SECRET+'&response='+recaptcha,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded'}
        }
      )).json();
      if (!responseCaptcha.success) {
        return res.json({ success: false , msg: 'Captcha Incorrecto'});
      }
    }
    let userData = await findLoginUser(user);

    if (!userData) {
      return res.json({ success: false , msg: 'Ingrese usuario y contraseña'});
    }
    if (!userData.activo) {
      return res.json({ success: false , msg: 'Usuario no permitido'});
    }
    
    // Si se está usando passkey, la autenticación se maneja en passkeysController
    // Aquí solo validamos la contraseña tradicional
    if (usePasskey) {
      // La autenticación con passkey se maneja en otro endpoint
      return res.json({ success: false, msg: 'Use el botón de passkey para autenticarse' });
    }
    
    // Autenticación tradicional con contraseña
    bcrypt.compare(pword, userData.upass)
      .then(async (data) => {
        if (!data){
          return res.json({ success: false , msg: 'Ingrese usuario y contraseña'});
        } else {
          const token = jwt.sign(
            {
              id_user: userData.id_user,
              id_group: process.env.GRUPO_APLICACIONES,
              user: userData.uname
            },
            process.env.SECRET
          );
          const cookiesOptions = {
            // Sin expires/maxAge => cookie de sesión (se elimina al cerrar navegador).
            httpOnly: true,
          };
          res.cookie(process.env.APP_COOKIE_NAME, token, cookiesOptions);
          return res.json({ success: true , msg: ''});
        }
      });
  } catch(error){
    console.error(error);
    return res.json({ success: false , msg: 'Intente más tarde'});
  }
}
async function apLoginAD(req, res){
  try {
    const user = req.body.user.trim().toLowerCase()//.replace('@imssbienestar.gob.mx','@opdib.gob.mx')//.split('@')[0]+'@opdib.gob.mx'; 
    const pword = req.body.pass;
    const recaptcha = req.body['g-recaptcha-response'] ?? '';

    if (!user || !pword) {
      return res.json({ success: false , msg: 'Ingrese usuario y contraseña[0]'});
    }
    if (process.env.CAPTCHA_MOSTRAR == 'true' && recaptcha == '') {
      return res.json({ success: false , msg: 'Captcha Incorrecto'});
    }
    if (process.env.CAPTCHA_MOSTRAR == 'true') {
      const responseCaptcha = await (await fetch(
        'https://www.google.com/recaptcha/api/siteverify',
        {
          method: 'POST',
          body: 'secret='+process.env.CAPTCHA_SECRET+'&response='+recaptcha/*+'&remoteip=' *//*JSON.stringify({
            secret: process.env.CAPTCHA_SECRET,
            response: recaptcha,
          //remoteip
          }),*/,
          headers: { 'Content-Type': /*'application/json'*/ 'application/x-www-form-urlencoded'}
        }
      )).json();
      if (!responseCaptcha.success) {
        return res.json({ success: false , msg: 'Captcha Incorrecto'});
      }
    }


    if(!(/@imssbienestar.gob.mx/.test(user)||/@opdib.gob.mx/.test(user))){
      return res.json({ success: false , msg: 'Correo no  válido'});
    }
    const user_opd = user.replace('@imssbienestar.gob.mx','@opdib.gob.mx');
    let config = {
      url: 'ldap://172.16.19.1:389',
      baseDN: 'DC=opdib,DC=gob,DC=mx',
      //filter: '(&(objectClass=user)(objectCategory=person))',
      //bindDN: 'OPDIB\mesa.ldap',
      username: user_opd,
      password: pword
    }
    let ad = new ActiveDirectory(config);
    ad.authenticate(user_opd,pword,(err, auth)=>{
      if (err) {
        console.error('ERROR: '+JSON.stringify(err));
        return res.json({ success: false , msg: 'Intente más tarde'});
      }
      if (auth) {
        // console.log('Authenticated!');
        const attributes = ['userPrincipalName', 'mail', 'sn', 'givenName', 'cn', 'displayName', 'description', 'pager'];
        ad.findUser({ attributes: attributes },user_opd.split('@')[0],async (err, userAD)=>{
          if (err) {
            console.error('ERROR: '+JSON.stringify(err));
            return res.json({ success: false , msg: 'Intente más tarde'});
          }
          else {
            let userData = await findLoginUser(userAD.mail);
            if (!userData || !userData.activo) {
              return res.json({ success: false , msg: 'Usuario no permitido'});
            }

            if(userData.email == user){
              const token = jwt.sign(
                {
                  id_user: userData.id_user,
                },
                process.env.SECRET
              );

              const cookiesOptions = {
                // Sin expires/maxAge => cookie de sesión (se elimina al cerrar navegador).
                httpOnly: true,
              };
              res.cookie(process.env.APP_COOKIE_NAME, token, cookiesOptions);
              return res.json({ success: true , msg: 'Inicio Correcto'});
            }
            else{
              return res.json({ success: false , msg: 'Ingrese usuario y contraseña[1]'});
            }
          }
        });
      }
      else {
        return res.json({ success: false , msg: 'Ingrese usuario y contraseña[2]'});
      }
    });
  } catch(error){
    console.error(error);
    return res.json({ success: false , msg: 'Intente más tarde'});
  }
}
async function psw(req, res) {
  try {
    const id_user = req.usdata.id_user;
    const pass = req.body.pass;
    const passConf = req.body.passConf;
    let passtr = pass.toString();
    
    //variables de caracteristicas
    const longitud=8;
    const mayusculas=/[A-ZÑ]+/;
    const minusculas=/[a-zñ]+/;
    const numero=/\d+/;
    const caracteresEspeciales=/[|°¬!'#$%&/()='?\\¿¡@´¨+*~{[^}\]`<>,;.:\-_]+/;//20240321

    if (//necesario el toString ??
      passtr==''
      || passtr != passConf.toString()
      || pass.length < longitud
      || !mayusculas.test(passtr)
      || !minusculas.test(passtr)
      || !numero.test(passtr)
      || !caracteresEspeciales.test(passtr)
    ) return;//No deberia pasar esto ya que se debe validar desde el front
    const saltRounds = 10;
    const salt = bcrypt.genSaltSync(saltRounds);
    const passws = pass;
    const hashedPass = bcrypt.hashSync(passws, salt);
    const resultUpdate = await userModel.update(
      { campass: true, upass: hashedPass },
      { where: { id_user: id_user } }
  );
    // En lugar de redirigir, renderizar la vista con flag de contraseña cambiada
    // para mostrar la opción de registrar passkey
    return res.render('psw', { 
      passwordChanged: true,
      ...req.usdata 
    });
  } catch (error) {
    console.log('Error: ' + error);
    return res.render('psw', { 
      passwordChanged: false,
      error: 'Error al cambiar contraseña',
      ...req.usdata 
    });
  }
}
function logout(req, res){
  res.clearCookie(process.env.APP_COOKIE_NAME);
  const host = req.get('host') || '';
  // Si es localhost, redirigir a /admin, sino usar la configuración de APP_BASE_URL_ADMIN
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return res.redirect('/admin');
  } else {
    const url_redireccion = '/' + process.env.APP_BASE_URL_ADMIN.replace(/https?:\/\//, '').split('/')[1];
    return res.redirect(url_redireccion || '/');
  }
};

module.exports = {
  // apLogin,
  // apLoginAD,
  login,
  psw,
  logout,
}
