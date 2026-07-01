/**
 * Ancho mínimo en columnas Bootstrap (12 = fila completa).
 * Debe mantenerse alineado con `minComponentSizes` en editpag_canvas.ejs
 */
const COMPONENT_MIN_COLS = {
    1: 12,
    2: 3,
    3: 3,
    4: 3,
    5: 12,
    7: 3,
    8: 12,
    9: 12,
    10: 12,
    13: 3,
    14: 12,
    16: 12,
    17: 12,
    20: 3,
    21: 3,
    23: 3,
    24: 12,
};

function minColsForComponentType(idCat) {
    const n = parseInt(idCat, 10);
    if (Number.isNaN(n)) return 3;
    return Object.prototype.hasOwnProperty.call(COMPONENT_MIN_COLS, n)
        ? COMPONENT_MIN_COLS[n]
        : 3;
}

/** Componente que solo es válido con una columna de ancho 12 (toda la fila) */
function isFullWidthComponentType(idCat) {
    return minColsForComponentType(idCat) >= 12;
}

module.exports = {
    COMPONENT_MIN_COLS,
    minColsForComponentType,
    isFullWidthComponentType,
};
