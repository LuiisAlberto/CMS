const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const authController = require('../controllers/authController');
const dashController = require('../controllers/dashController');
const usuariosController = require('../controllers/usuariosController');
const multer = require('multer');
const paginasController = require('../controllers/pagsController');
const menuController = require('../controllers/menuController');
const footerController = require('../controllers/footerController');
const documentosController = require('../controllers/documentosController');
const categoriasController = require('../controllers/categoriasController');
const publicController = require('../controllers/publicController');
const adminController = require('../controllers/adminController');
const agentController = require('../controllers/agentController');
const metricsController = require('../controllers/metricsController');
const hostingController = require('../controllers/hostingController');
const bitacoraController = require('../controllers/bitacoraController');
const upload = multer();

const uploadLogoFooter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
});
function uploadFooterMiddleware(req, res, next) {
    uploadLogoFooter.any()(req, res, function (err) {
        if (err && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'El logo supera el tamaño máximo permitido (2 MB).',
            });
        }
        return next(err);
    });
}

/** Ruta inicio */
router.get('/', dashController.inicio);
/** Ruta admin - redirige al login si no hay sesión */
router.get('/admin', dashController.inicio);
/** Rutas Modulo Usuarios */
router.get('/users', auth.isAuthenticated, usuariosController.ensureSuperUsersAccess, usuariosController.users);
router.post('/NuevoUsuario', auth.isAuthenticated, usuariosController.adduser);
router.post('/NuevoUsuarioValidarCurp', auth.isAuthenticated, usuariosController.NuevoUsuarioValidarCurp);
router.post('/obtenerPermisosUser', auth.isAuthenticated, usuariosController.ensureSuperUsersAccess, usuariosController.obtenerPermisosUser);
router.post('/editarPermisosUser', auth.isAuthenticated, usuariosController.ensureSuperUsersAccess, usuariosController.editarPermisosUser);
router.post('/desactivarUser', auth.isAuthenticated, usuariosController.ensureSuperUsersAccess, usuariosController.deActiveUser);
router.post('/reactivarUser', auth.isAuthenticated, usuariosController.ensureSuperUsersAccess, usuariosController.reActiveUser);
router.post('/actualizarContrasenaUser', auth.isAuthenticated, usuariosController.ensureSuperUsersAccess, usuariosController.actualizarContrasenaUser);
router.post('/obtenerAdminView', auth.isAuthenticated, usuariosController.ensureSuperUsersAccess, usuariosController.obtenerAdminView);
router.post('/obtenerPermisosUserInstancia', auth.isAuthenticated, usuariosController.ensureInstanceUsersAccess, usuariosController.obtenerPermisosUserInstance);
router.post('/obtenerAdminViewInstancia', auth.isAuthenticated, usuariosController.ensureInstanceUsersAccess, usuariosController.obtenerAdminViewInstance);
router.post('/obtenerPaginaScopeUserInstancia', auth.isAuthenticated, usuariosController.ensureInstanceUsersAccess, usuariosController.obtenerPaginaScopeUserInstance);
router.post('/opcionesPaginasAlcanceInstancia', auth.isAuthenticated, usuariosController.ensureInstanceUsersAccess, usuariosController.opcionesPaginasAlcanceInstancia);
router.post('/editarPermisosUserInstancia', auth.isAuthenticated, usuariosController.ensureInstanceUsersAccess, usuariosController.editarPermisosUserInstance);
router.get('/users-instancia', auth.isAuthenticated, usuariosController.ensureInstanceUsersAccess, usuariosController.users);

// router.post('/p/getDocumentosFirma', auth.isAuthenticated, sqlServerController.getDocumentosFirma);
// router.post('/p/getFormatoCoord', auth.isAuthenticated, sqlServerController.getFormatoCoord);

/** Rutas autenticación */
router.post('/login', authController.login);
router.post('/psw', auth.isAuthenticated, authController.psw);
router.get('/logout', authController.logout);

/** Rutas passkeys */
const passkeysController = require('../controllers/passkeysController');
router.post('/api/passkeys/register/start', auth.isAuthenticated, passkeysController.registerStart);
router.post('/api/passkeys/register/finish', auth.isAuthenticated, passkeysController.registerFinish);
router.post('/api/passkeys/authenticate/start', passkeysController.authenticateStart);
router.post('/api/passkeys/authenticate/finish', passkeysController.authenticateFinish);
router.post('/api/passkeys/check', passkeysController.checkUserHasPasskeys);
router.get('/api/passkeys', auth.isAuthenticated, passkeysController.getUserPasskeys);
router.post('/api/passkeys/delete', auth.isAuthenticated, passkeysController.deletePasskey);


/** ADMIN **/
router.get('/instancias', auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.instanciasList);
router.post('/CreateInst', upload.fields([
    { name: 'cargar-favicon', maxCount: 1 },
    { name: 'cargar-logo', maxCount: 1 }
]), auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.CreateInst);
router.get('/DeleteInst', auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.DeleteInst);
router.get('/PubInst', auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.PubInst);
router.post('/marcarPaginasCompletadas', auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.marcarPaginasCompletadas);
router.post('/solicitarDominio', auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.solicitarDominio);
router.get('/solicitarDominio/status/:jobId', auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.solicitarDominioStatus);
router.post('/solicitarBajaDominio', auth.isAuthenticated, auth.ensureSubmoduleAccess('/instancias'), adminController.solicitarBajaDominio);

/** Hosting (Infra) */
router.get('/hosting', auth.isAuthenticated, auth.ensureSubmoduleAccess('/hosting'), hostingController.hostingView);
router.post('/hosting/aprobar', auth.isAuthenticated, auth.ensureSubmoduleAccess('/hosting'), hostingController.confirmarDominio);
router.post('/hosting/confirmar', auth.isAuthenticated, auth.ensureSubmoduleAccess('/hosting'), hostingController.confirmarDominio);
router.post('/hosting/rechazar', auth.isAuthenticated, auth.ensureSubmoduleAccess('/hosting'), hostingController.rechazarDominio);
router.post('/hosting/procesar-baja', auth.isAuthenticated, auth.ensureSubmoduleAccess('/hosting'), hostingController.procesarBaja);
router.get('/admin/bitacora', auth.isAuthenticated, auth.ensureSubmoduleAccess('/admin/bitacora'), bitacoraController.bitacoraView);

/** Rutas páginas */
router.get('/paginas', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.paginasList);
router.get('/inicial', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.paginaPrincipalView);
router.get('/menu', auth.isAuthenticated, auth.ensureSubmoduleAccess('/menu'), menuController.menuView);
router.get('/menudetalle', auth.isAuthenticated, auth.ensureSubmoduleAccess('/menu'), menuController.menuDetalleView);
router.get('/documentos', auth.isAuthenticated, auth.ensureSubmoduleAccess('/documentos'), documentosController.docsView);
router.get('/imagenes', auth.isAuthenticated, auth.ensureSubmoduleAccess('/imagenes'), documentosController.imagenesView);
router.get('/categorias', auth.isAuthenticated, auth.ensureSubmoduleAccess('/categorias'), categoriasController.categoriasView);
router.get('/api/tags', auth.isAuthenticated, auth.ensureSubmoduleAccess('/categorias'), categoriasController.getTagsForComponent);
router.post('/categorias/create', auth.isAuthenticated, auth.ensureSubmoduleAccess('/categorias'), upload.none(), categoriasController.createTag);
router.post('/categorias/update', auth.isAuthenticated, auth.ensureSubmoduleAccess('/categorias'), upload.none(), categoriasController.updateTag);
router.post('/categorias/delete', auth.isAuthenticated, auth.ensureSubmoduleAccess('/categorias'), upload.none(), categoriasController.deleteTag);
router.get('/GetImages', auth.isAuthenticated, auth.ensureSubmoduleAccess('/imagenes'), documentosController.GetImages);
router.get('/GetDocs', auth.isAuthenticated, auth.ensureSubmoduleAccess('/documentos'), documentosController.GetDocs);
router.get('/DeletePag', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.DeletePag);
router.get('/PubPag', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.PubPag);

router.get('/editarpagina', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.editarPag);

router.post('/CreatePag', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.multer.single('cargar-imagpag'), paginasController.CreatePag);
router.post('/CreateImg', auth.isAuthenticated, auth.ensureSubmoduleAccess('/imagenes'), documentosController.multerDoc.single('cargar-imag'), documentosController.CreateImg);
router.post('/DeleteImg', auth.isAuthenticated, auth.ensureSubmoduleAccess('/imagenes'), documentosController.multerDoc.none(), documentosController.DeleteImg);
router.post('/CreateDoc', auth.isAuthenticated, auth.ensureSubmoduleAccess('/documentos'), documentosController.multerDoc.single('cargar-doc'), documentosController.CreateDoc);
router.post('/GetDoc', auth.isAuthenticated, auth.ensureSubmoduleAccess('/documentos'), documentosController.multerDoc.none(), documentosController.GetDoc);
router.post('/DeleteDoc', auth.isAuthenticated, auth.ensureSubmoduleAccess('/documentos'), documentosController.multerDoc.none(), documentosController.DeleteDoc);
router.post('/GetPostContent', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.GetPostContent);
router.post('/getComponenteObj', auth.isAuthenticated, documentosController.multerDoc.none(), publicController.getComponenteObj);
router.post('/DuplicarPag', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.duplicarPagina);
router.post('/getBorPag', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.getBorPag);
router.post('/agregarSeccion', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.getSec);
router.post('/agregarColumna', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.getCol);
router.post('/eliminarColumna', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.deleteCol);
router.post('/eliminarSeccion', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.deleteSec);
router.post('/reordenarSeccion', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.reorderSec);


// Crear menú independiente/estatal
router.post('/api/menu', auth.isAuthenticated, auth.ensureSubmoduleAccess('/menu'), menuController.crearMenu);
router.post('/api/menu/:id', auth.isAuthenticated, auth.ensureSubmoduleAccess('/menu'), menuController.cambiarEstatusMenu);
//Menu detalle
router.post('/guardarMenu', upload.any(), auth.isAuthenticated, auth.ensureSubmoduleAccess('/menu'), menuController.guardarMenuCompleto);
router.post('/eliminar-imagen-menu', auth.isAuthenticated, auth.ensureSubmoduleAccess('/menu'), menuController.eliminarImagenMenu);
router.post('/eliminar-menu-item',  auth.isAuthenticated, auth.ensureSubmoduleAccess('/menu'), menuController.eliminarMenuItem);
router.post('/guardar-orden-menu', menuController.guardarOrdenMenu);
//
router.post('/menu-data', menuController.obtenerMenuFrontend);

// Rutas Footer
router.get('/footer', auth.isAuthenticated, auth.ensureSubmoduleAccess('/footer'), footerController.footerView);
router.post('/api/footer', auth.isAuthenticated, auth.ensureSubmoduleAccess('/footer'), footerController.crearFooter);
router.post('/api/footer/:id', auth.isAuthenticated, auth.ensureSubmoduleAccess('/footer'), footerController.cambiarEstatusFooter);
router.get('/footerdetalle', auth.isAuthenticated, auth.ensureSubmoduleAccess('/footer'), footerController.footerDetalleView);
router.post('/guardarFooter', uploadFooterMiddleware, auth.isAuthenticated, auth.ensureSubmoduleAccess('/footer'), footerController.guardarFooterCompleto);
router.post('/eliminar-logo-footer', auth.isAuthenticated, auth.ensureSubmoduleAccess('/footer'), footerController.eliminarLogoFooter);
router.post('/footer-data', footerController.obtenerFooterFrontend);

router.post('/CreateComp', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.CreateComp);
router.post('/CreateFirstSlide', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.CreateFirstSlideComp);
router.post('/AddSlides', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.AddSlides);
router.post('/DeleteSlide', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.DeleteSlides);
router.post('/SaveAllSlidesStatus', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.UpdateSlides);
router.post('/SaveAllSlidesData', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.SaveAllSlidesData);
router.post('/CreateRegeneracion', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.CreateRegeneracion);
router.post('/EditRegeneracion', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.EditRegeneracion);
router.post('/GetRegeneracion', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.GetRegeneracion);
router.post('/DeleteRegeneracion', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.DeleteRegeneracion);

router.post('/getCompDataToEdit', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.getCompDataToEdit);
router.post('/getCompToDelete', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.getCompToDelete);



// router.post('/componentes/editar', auth.isAuthenticated, paginasController.editarComponente);
// router.post('/componentes/eliminar', auth.isAuthenticated, paginasController.eliminarComponente);
// router.post('/componentes/ordenar', auth.isAuthenticated, paginasController.ordenarComponentes);
// router.get('/componentes/:id', auth.isAuthenticated, paginasController.obtenerComponente);
// router.get('/componentes/pagina/:paginaId', auth.isAuthenticated, paginasController.obtenerComponentesPagina);

/** Rutas para versión pública */
router.post('/public/getComponente', publicController.getComponentes);
router.post('/getDataTag', publicController.getTagImg);

// Rutas para componentes
router.get('/tags', paginasController.paginaTags);
router.get('/detalle', paginasController.paginaTagDetalle);
router.get('/regeneracion', paginasController.pagRegeneracionDetalle);

router.post('/consultarURL', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.consultarURL);
router.post('/updateComponentData', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), upload.any(), paginasController.updateComponentData);

//Peticiones para el acordeon
router.post('/crear-componente-acordeon', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.createComponenteAcordeon);
router.post('/agregar-categoria-acordeon', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.addCategoriaAcordeon);
router.post('/agregar-subcategoria-acordeon', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.addSubcategoriaAcordeon);
router.post('/agregar-acordeon', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.addAcordeon);
router.post('/obtener-acordeon-datos', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.getAcordeonDataToEdit);
router.post('/acordeon-subcategoria-documentos', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.setSubcategoriaDocumentos);
router.post('/eliminar-elemento-acordeon', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.deleteElementoAcordeon);
router.post('/publicar-acordeon', auth.isAuthenticated, auth.ensureSubmoduleAccess('/paginas'), paginasController.publicarAcordeon);

// Rutas del agente de IA
router.post('/agent/analyze', auth.isAuthenticated, agentController.analyzeUserPrompt);
router.post('/agent/create', auth.isAuthenticated, agentController.createComponentFromAgent);
router.post('/agent/create-section', auth.isAuthenticated, agentController.createSectionFromAgent);

// Métricas (Google Search Console)
router.get('/metricas', auth.isAuthenticated, auth.ensureSubmoduleAccess('/metricas'), metricsController.metricsView);
router.get('/api/metrics/data', auth.isAuthenticated, auth.ensureSubmoduleAccess('/metricas'), metricsController.getMetricsData);
router.get('/api/metrics/status', auth.isAuthenticated, auth.ensureSubmoduleAccess('/metricas'), metricsController.getMetricsStatus);

module.exports = router;