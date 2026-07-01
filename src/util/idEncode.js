/**
 * Codificación/decodificación de IDs para URLs.
 * Evita exponer IDs numéricos o nombres de campos de BD en la URL.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const SALT = 'idenc'; // Prefijo para el payload

function getKey() {
    const secret = process.env.SECRET || process.env.ID_ENCODE_SECRET || 'cms-morena-default';
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Codifica un ID numérico a string URL-safe.
 * @param {number} id - ID a codificar
 * @returns {string} - String base64url (sin +/=)
 */
function encodeId(id) {
    if (id == null || isNaN(parseInt(id, 10))) return '';
    const num = parseInt(id, 10);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const payload = SALT + String(num);
    let encrypted = cipher.update(payload, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const combined = Buffer.concat([iv, Buffer.from(encrypted, 'base64')]);
    return combined.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * Decodifica un string a ID numérico.
 * @param {string} encoded - String codificado
 * @returns {number|null} - ID o null si inválido
 */
function decodeId(encoded) {
    if (!encoded || typeof encoded !== 'string') return null;
    try {
        const normal = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const pad = normal.length % 4;
        const padded = pad ? normal + '='.repeat(4 - pad) : normal;
        const combined = Buffer.from(padded, 'base64');
        if (combined.length < IV_LENGTH + 1) return null;
        const iv = combined.subarray(0, IV_LENGTH);
        const encrypted = combined.subarray(IV_LENGTH);
        const key = getKey();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encrypted.toString('base64'), 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        if (!decrypted.startsWith(SALT)) return null;
        const num = parseInt(decrypted.slice(SALT.length), 10);
        return isNaN(num) ? null : num;
    } catch {
        return null;
    }
}

module.exports = { encodeId, decodeId };
