'use strict';

/**
 * Normaliza color tipo #RRGGBB o vacío → null (usa tema por defecto en UI).
 */
function normalizeColorAccent(val) {
    if (val == null) return null;
    const s0 = String(val).trim();
    if (s0 === '' || s0.toLowerCase() === 'null' || s0.toLowerCase() === 'undefined') return null;
    let s = s0.startsWith('#') ? s0 : '#' + s0;
    if (!/^#[0-9A-Fa-f]{6}$/.test(s)) return null;
    return s.toLowerCase();
}

function hexToRgb(hex) {
    const h = hex.replace(/^#/, '');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
    const to = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
}

/** Oscurece un hex mezclando hacia negro (0–1). */
function darkenHex(hex, t) {
    const { r, g, b } = hexToRgb(hex);
    const k = 1 - Math.max(0, Math.min(1, t));
    return rgbToHex(r * k, g * k, b * k);
}

function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            default: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rp = 0;
    let gp = 0;
    let bp = 0;
    if (h < 60) {
        rp = c; gp = x; bp = 0;
    } else if (h < 120) {
        rp = x; gp = c; bp = 0;
    } else if (h < 180) {
        rp = 0; gp = c; bp = x;
    } else if (h < 240) {
        rp = 0; gp = x; bp = c;
    } else if (h < 300) {
        rp = x; gp = 0; bp = c;
    } else {
        rp = c; gp = 0; bp = x;
    }
    return rgbToHex((rp + m) * 255, (gp + m) * 255, (bp + m) * 255);
}

/**
 * Recolorea un SVG con el matiz y la saturación del color elegido.
 * La luminosidad combina el tono global que eliges (claro/oscuro) con el contraste del dibujo:
 * se desplaza la L de cada trazo respecto al gris medio (50%), así un casi blanco (#f7f7f7)
 * no deja sombras negras solo porque el SVG original era rojo oscuro.
 */
function recolorSvgPreserveDepth(svgString, baseHex) {
    const bh = rgbToHsl(...Object.values(hexToRgb(baseHex)));
    return svgString.replace(/#([0-9a-fA-F]{6})/g, (_, hh) => {
        const oldHex = '#' + hh.toLowerCase();
        const oh = rgbToHsl(...Object.values(hexToRgb(oldHex)));
        const l = Math.min(100, Math.max(0, bh.l + (oh.l - 50)));
        return hslToHex(bh.h, bh.s, l);
    });
}

module.exports = {
    normalizeColorAccent,
    hexToRgb,
    rgbToHex,
    darkenHex,
    recolorSvgPreserveDepth,
};
