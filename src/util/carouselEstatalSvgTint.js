'use strict';

const fs = require('fs');
const path = require('path');
const { recolorSvgPreserveDepth } = require('./colorAccent');

const SVG_PATH = path.join(
    __dirname,
    '../public/assets/img/recursos_componentes/CARRUSEL ESTATAL 2.svg'
);

let cachedOriginal = null;

function getOriginalSvg() {
    if (cachedOriginal == null) {
        cachedOriginal = fs.readFileSync(SVG_PATH, 'utf8');
    }
    return cachedOriginal;
}

/**
 * Devuelve data URI (svg+xml) para usar como background-image del carrusel estatal.
 */
function carouselEstatalSvgAsDataUri(baseHex) {
    const tinted = recolorSvgPreserveDepth(getOriginalSvg(), baseHex);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(tinted);
}

module.exports = {
    carouselEstatalSvgAsDataUri,
};
