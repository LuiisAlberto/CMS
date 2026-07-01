const passkeysModel = require('../models/passkeys');
const userModel = require('../models/users');
const crypto = require('crypto');

// Almacenar challenges temporalmente (en producción usar Redis o similar)
const challenges = new Map();

/**
 * rp.id (WebAuthn). Orden: WEBAUTHN_RP_ID → APP_BASE_URL_ADMIN → Origin → Referer → X-Forwarded-Host → Host.
 */
function resolveWebAuthnRpId(req) {
  const explicit = process.env.WEBAUTHN_RP_ID && String(process.env.WEBAUTHN_RP_ID).trim();
  if (explicit) {
    return normalizeLoopbackHostname(explicit.split(':')[0].toLowerCase());
  }

  if (process.env.APP_BASE_URL_ADMIN) {
    let origin = process.env.APP_BASE_URL_ADMIN.replace(/\/admin.*$/, '');
    if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
      origin = `${req.protocol}://${origin}`;
    }
    try {
      const hostname = new URL(origin).hostname.toLowerCase();
      return normalizeLoopbackHostname(hostname);
    } catch {
      /* continuar */
    }
  }

  const originHeader = req.get('origin');
  if (originHeader) {
    try {
      const hostname = new URL(originHeader).hostname;
      if (hostname) {
        return normalizeLoopbackHostname(hostname.toLowerCase());
      }
    } catch {
      /* continuar */
    }
  }

  const referer = req.get('referer');
  if (referer) {
    try {
      const hostname = new URL(referer).hostname;
      if (hostname) {
        return normalizeLoopbackHostname(hostname.toLowerCase());
      }
    } catch {
      /* continuar */
    }
  }

  const forwarded = req.get('x-forwarded-host');
  if (forwarded) {
    const h = forwarded.split(',')[0].trim().split(':')[0].toLowerCase();
    return normalizeLoopbackHostname(h);
  }

  const host = req.get('host') || '';
  const h = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  return normalizeLoopbackHostname(h);
}

function normalizeLoopbackHostname(hostname) {
  if (hostname === '127.0.0.1' || hostname === '::1') {
    return 'localhost';
  }
  return hostname;
}

/**
 * Iniciar registro de passkey
 * Genera un challenge y lo devuelve al cliente
 */
async function registerStart(req, res) {
  try {
    const id_user = req.usdata.id_user;
    
    if (!id_user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }

    // Generar challenge aleatorio
    const challenge = crypto.randomBytes(32).toString('base64url');
    
    // Guardar challenge temporalmente (expira en 5 minutos)
    challenges.set(`register_${id_user}`, {
      challenge,
      userId: id_user,
      timestamp: Date.now()
    });

    // Obtener el nombre de usuario para el registro
    const user = await userModel.findOne({ where: { id_user } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    const rpId = resolveWebAuthnRpId(req);

    // Crear opciones de registro para WebAuthn
    const registrationOptions = {
      challenge: challenge,
      rp: {
        name: 'Sistema de Administración de Contenido Institucional',
        id: rpId,
      },
      user: {
        id: Buffer.from(id_user.toString()).toString('base64url'),
        name: user.uname || user.email || `usuario_${id_user}`,
        displayName: `${user.nombre || ''} ${user.primer_apellido || ''}`.trim() || user.uname || `Usuario ${id_user}`,
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' }, // ES256
        { alg: -257, type: 'public-key' }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'preferred',
      },
      timeout: 60000,
      attestation: 'direct',
    };

    return res.json({ success: true, options: registrationOptions });
  } catch (error) {
    console.error('Error en registerStart:', error);
    return res.status(500).json({ success: false, message: 'Error al iniciar registro de passkey' });
  }
}

/**
 * Completar registro de passkey
 * Verifica la respuesta del cliente y guarda la passkey
 */
async function registerFinish(req, res) {
  try {
    const id_user = req.usdata.id_user;
    const { credential, deviceName } = req.body;

    if (!id_user || !credential) {
      return res.status(400).json({ success: false, message: 'Datos incompletos' });
    }

    // Verificar que existe el challenge
    const challengeData = challenges.get(`register_${id_user}`);
    if (!challengeData) {
      return res.status(400).json({ success: false, message: 'Challenge no encontrado o expirado' });
    }

    // Limpiar challenge usado
    challenges.delete(`register_${id_user}`);

    // Verificar que el challenge coincide
    if (credential.response && credential.response.clientDataJSON) {
      try {
        // Convertir de base64url a string
        let clientDataJSON = credential.response.clientDataJSON;
        // Asegurar padding correcto para base64
        const padding = '='.repeat((4 - clientDataJSON.length % 4) % 4);
        clientDataJSON = clientDataJSON.replace(/-/g, '+').replace(/_/g, '/') + padding;
        
        const clientDataStr = Buffer.from(clientDataJSON, 'base64').toString();
        const clientData = JSON.parse(clientDataStr);
        
        // El challenge viene como base64url string en clientData
        // Necesitamos decodificarlo y compararlo con el challenge original
        const receivedChallengeBase64 = clientData.challenge;
        const expectedChallenge = challengeData.challenge;
        
        // Normalizar ambos challenges para comparación
        const normalizeBase64 = (str) => str.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
        const normalizedReceived = normalizeBase64(receivedChallengeBase64);
        const normalizedExpected = normalizeBase64(expectedChallenge);
        
        if (normalizedReceived !== normalizedExpected) {
          console.error('Challenge mismatch:', { received: normalizedReceived, expected: normalizedExpected });
          return res.status(400).json({ success: false, message: 'Challenge no válido' });
        }
      } catch (error) {
        console.error('Error al verificar challenge:', error);
        return res.status(400).json({ success: false, message: 'Error al verificar challenge' });
      }
    }

    // Extraer datos de la credencial
    const credentialId = credential.id;
    const publicKey = JSON.stringify({
      id: credential.id,
      rawId: credential.rawId,
      response: {
        attestationObject: credential.response.attestationObject,
        clientDataJSON: credential.response.clientDataJSON,
      },
      type: credential.type,
    });

    // Guardar la passkey en la base de datos
    await passkeysModel.create({
      fk_id_user: id_user,
      credential_id: credentialId,
      public_key: publicKey,
      counter: 0,
      device_name: deviceName || 'Dispositivo desconocido',
      vigente: true,
    });

    return res.json({ 
      success: true, 
      message: 'Passkey registrada exitosamente',
    });
  } catch (error) {
    console.error('Error en registerFinish:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ success: false, message: 'Esta passkey ya está registrada' });
    }
    return res.status(500).json({ success: false, message: 'Error al registrar passkey' });
  }
}

/**
 * Iniciar autenticación con passkey
 * Genera un challenge para autenticación
 */
async function authenticateStart(req, res) {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ success: false, message: 'Usuario requerido' });
    }

    // Buscar usuario
    const user = await userModel.findOne({ where: { uname: username.toLowerCase() } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    // Buscar passkeys del usuario
    const userPasskeys = await passkeysModel.findAll({
      where: { fk_id_user: user.id_user, vigente: true },
    });

    if (userPasskeys.length === 0) {
      return res.status(404).json({ success: false, message: 'No hay passkeys registradas para este usuario' });
    }

    // Generar challenge
    const challenge = crypto.randomBytes(32).toString('base64url');
    
    // Guardar challenge
    challenges.set(`auth_${user.id_user}`, {
      challenge,
      userId: user.id_user,
      timestamp: Date.now()
    });

    // Preparar allowedCredentials
    const allowCredentials = userPasskeys.map(pk => ({
      id: pk.credential_id,
      type: 'public-key',
    }));

    const rpId = resolveWebAuthnRpId(req);

    const authenticationOptions = {
      challenge: challenge,
      allowCredentials: allowCredentials,
      timeout: 60000,
      rpId: rpId,
      userVerification: 'preferred',
    };

    return res.json({ success: true, options: authenticationOptions });
  } catch (error) {
    console.error('Error en authenticateStart:', error);
    return res.status(500).json({ success: false, message: 'Error al iniciar autenticación' });
  }
}

/**
 * Completar autenticación con passkey
 * Verifica la respuesta y autentica al usuario
 */
async function authenticateFinish(req, res) {
  try {
    const { credential } = req.body;

    if (!credential || !credential.id) {
      return res.status(400).json({ success: false, message: 'Credencial incompleta' });
    }

    // Buscar la passkey por credential_id
    const passkey = await passkeysModel.findOne({
      where: { credential_id: credential.id, vigente: true },
    });

    if (!passkey) {
      return res.status(404).json({ success: false, message: 'Passkey no encontrada' });
    }

    // Verificar challenge
    const challengeData = challenges.get(`auth_${passkey.fk_id_user}`);
    if (!challengeData) {
      return res.status(400).json({ success: false, message: 'Challenge no encontrado o expirado' });
    }

    // Limpiar challenge
    challenges.delete(`auth_${passkey.fk_id_user}`);

    // Verificar clientDataJSON
    if (credential.response && credential.response.clientDataJSON) {
      try {
        // Convertir de base64url a string
        let clientDataJSON = credential.response.clientDataJSON;
        // Asegurar padding correcto para base64
        const padding = '='.repeat((4 - clientDataJSON.length % 4) % 4);
        clientDataJSON = clientDataJSON.replace(/-/g, '+').replace(/_/g, '/') + padding;
        
        const clientDataStr = Buffer.from(clientDataJSON, 'base64').toString();
        const clientData = JSON.parse(clientDataStr);
        
        // El challenge viene como base64url string en clientData
        const receivedChallengeBase64 = clientData.challenge;
        const expectedChallenge = challengeData.challenge;
        
        // Normalizar ambos challenges para comparación
        const normalizeBase64 = (str) => str.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
        const normalizedReceived = normalizeBase64(receivedChallengeBase64);
        const normalizedExpected = normalizeBase64(expectedChallenge);
        
        if (normalizedReceived !== normalizedExpected) {
          console.error('Challenge mismatch en autenticación:', { received: normalizedReceived, expected: normalizedExpected });
          return res.status(400).json({ success: false, message: 'Challenge no válido' });
        }
      } catch (error) {
        console.error('Error al verificar challenge en autenticación:', error);
        return res.status(400).json({ success: false, message: 'Error al verificar challenge' });
      }
    }

    // Actualizar counter
    await passkeysModel.update(
      { counter: passkey.counter + 1 },
      { where: { id_passkey: passkey.id_passkey } }
    );

    // Obtener usuario
    const user = await userModel.findOne({ where: { id_user: passkey.fk_id_user } });
    if (!user || !user.activo) {
      return res.status(403).json({ success: false, message: 'Usuario no permitido' });
    }

    // Generar token JWT
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      {
        id_user: user.id_user,
        id_group: process.env.GRUPO_APLICACIONES,
        user: user.uname
      },
      process.env.SECRET
    );

    const cookiesOptions = {
      // Sin expires/maxAge => cookie de sesión (se elimina al cerrar navegador).
      httpOnly: true,
    };

    res.cookie(process.env.APP_COOKIE_NAME, token, cookiesOptions);
    return res.json({ success: true, message: 'Autenticación exitosa' });
  } catch (error) {
    console.error('Error en authenticateFinish:', error);
    return res.status(500).json({ success: false, message: 'Error al autenticar con passkey' });
  }
}

/**
 * Verificar si un usuario tiene passkeys registradas (para login)
 */
async function checkUserHasPasskeys(req, res) {
  try {
    const { username } = req.body;

    if (!username) {
      return res.json({ success: false, hasPasskeys: false });
    }

    // Buscar usuario
    const user = await userModel.findOne({ where: { uname: username.toLowerCase() } });
    if (!user) {
      return res.json({ success: false, hasPasskeys: false });
    }

    // Buscar passkeys del usuario
    const userPasskeys = await passkeysModel.findAll({
      where: { fk_id_user: user.id_user, vigente: true },
    });

    return res.json({ success: true, hasPasskeys: userPasskeys.length > 0 });
  } catch (error) {
    console.error('Error en checkUserHasPasskeys:', error);
    return res.json({ success: false, hasPasskeys: false });
  }
}

/**
 * Obtener passkeys del usuario actual
 */
async function getUserPasskeys(req, res) {
  try {
    const id_user = req.usdata.id_user;
    
    const passkeys = await passkeysModel.findAll({
      where: { fk_id_user: id_user, vigente: true },
      attributes: ['id_passkey', 'device_name', 'f_reg'],
      order: [['f_reg', 'DESC']],
    });

    return res.json({ success: true, passkeys });
  } catch (error) {
    console.error('Error en getUserPasskeys:', error);
    return res.status(500).json({ success: false, message: 'Error al obtener passkeys' });
  }
}

/**
 * Eliminar una passkey
 */
async function deletePasskey(req, res) {
  try {
    const id_user = req.usdata.id_user;
    const { id_passkey } = req.body;

    if (!id_passkey) {
      return res.status(400).json({ success: false, message: 'ID de passkey requerido' });
    }

    // Verificar que la passkey pertenece al usuario
    const passkey = await passkeysModel.findOne({
      where: { id_passkey, fk_id_user: id_user },
    });

    if (!passkey) {
      return res.status(404).json({ success: false, message: 'Passkey no encontrada' });
    }

    // Marcar como no vigente
    await passkeysModel.update(
      { vigente: false },
      { where: { id_passkey } }
    );

    return res.json({ success: true, message: 'Passkey eliminada exitosamente' });
  } catch (error) {
    console.error('Error en deletePasskey:', error);
    return res.status(500).json({ success: false, message: 'Error al eliminar passkey' });
  }
}

module.exports = {
  registerStart,
  registerFinish,
  authenticateStart,
  authenticateFinish,
  getUserPasskeys,
  deletePasskey,
  checkUserHasPasskeys,
};
