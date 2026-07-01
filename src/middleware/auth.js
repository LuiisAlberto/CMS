const userModel = require('../models/users');
const CatalogModel = require('../models/CatalogModel');
const { getPreferredUsersInstanciaAppId, isUsersInstanciaSubmod } = require('../util/dedupeUsersInstanciaMenu');
const {
    applyResponsableMenuFilterIfNeeded,
    applyAdminGeneralMenuFilterIfNeeded
} = require('../util/instanceScope');
const jwt = require('jsonwebtoken');
const {promisify} = require('util');

/** Evita `res.redirect` + HTML en rutas consumidas con `fetch` (el cliente espera JSON). */
function clientExpectsJson(req) {
    const accept = String(req.get('accept') || '');
    if (accept.includes('application/json')) return true;
    if (String(req.get('sec-fetch-dest') || '') === 'empty') return true;
    if (String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest') return true;
    return false;
}

function jsonSesionInvalida(res, status = 401) {
    return res.status(status).json({
        success: false,
        error: 1,
        message: 'Tu sesión ha expirado o no es válida. Vuelve a iniciar sesión e intenta de nuevo.',
    });
}

async function isAuthenticated(req, res, next){
    // if (req.cookies[process.env.APP_COOKIE_NAME]) {
    //     try {
    //         const decoded = await promisify(jwt.verify)(req.cookies[process.env.APP_COOKIE_NAME], process.env.SECRET)
    //         userModel.findOne({ where: { id_user: decoded.id_user } })
    //         .then((data) => {
    //             req.usdata = data
    //             /*req.usdata.tipo_user = global.catalogos.cat_type_users[data.fk_id_tipo_user].type_user;
    //             req.usdata.nombre_entidad = global.catalogos.cat_entidades_admins[data.fk_id_entidad].fk_id_entidad;
    //             req.usdata.modulos=[];
    //             for(const id_sub_modulo of data._doc.permisos){
    //                 if(global.catalogos.sub_modulo[id_sub_modulo]){
    //                     req.usdata.modulos.push({
    //                         id_sub_modulo:id_sub_modulo,
    //                         ...global.catalogos.sub_modulo[id_sub_modulo]
    //                     });
    //                 }
    //             }*/
    //             return next(req,res)
    //         }).catch((error) => {
    //             // console.log(error)
    //             res.redirect('/');
    //         });
    //     } catch (error) {
    //         // console.log(error)
    //         res.redirect('/');
    //     }
    // } else {
    //     res.redirect('/');
    // }


    if (req.cookies[process.env.APP_COOKIE_NAME]) {
        try {
            const decoded = await promisify(jwt.verify)(
                req.cookies[process.env.APP_COOKIE_NAME],
                process.env.SECRET
            );

            if (decoded.id_user != '') {

                let data = await userModel.findOne({ where: { id_user: decoded.id_user } });
                //let dataLaboral = await usersInfoLaboral.findOne({ where: { fk_id_user: decoded.id_user } });
                // let datacomp = await complementariosModel.findOne({ fk_id_usereg: decoded.id_user });
                //let datareg = await registroModel.findOne({ fk_id_usereg: decoded.id_user });
                if (!data ) {
                    throw new Error('Error mdl');//Si alguno de los datos no se recabo, entonces mal.
                }
                //req.usdata = data;
                req.usdata = data.dataValues;
                const catTypeUsers = global.catalogos?.cat_type_users;
                if (!catTypeUsers || !Array.isArray(catTypeUsers)) {
                    if (clientExpectsJson(req)) {
                        return res.status(503).json({
                            success: false,
                            error: 1,
                            message:
                                'El servidor está reiniciando catálogos. Espera unos segundos y recarga la página.',
                        });
                    }
                    const host = req.get('host') || '';
                    if (host.includes('localhost') || host.includes('127.0.0.1')) {
                        return res.redirect('/admin?error=reiniciando');
                    }
                    return res.redirect('/?error=reiniciando');
                }
                const tu = catTypeUsers.find(e => e.id_cat_type_users == data.fk_id_cat_type_users);
                req.usdata.type_user = tu ? tu.type_user : 'Usuario';
                /*req.usdata.curp='Prueba';*/
                //req.usdata.tipo_user='Prueba';
                //req.usdata.tipo_user=dataLaboral.nombre_del_puesto;
                /*req.usdata.entidadnacimiento='Prueba';
                req.usdata.fechanac='Prueba';
                req.usdata.edad='Prueba';
                req.usdata.sexo='Prueba';*/
                let modulos_pre = await CatalogModel.getPermisos(data.id_user);
                let arr_modulos = {};
                for (let i = 0; i < modulos_pre.length; i++) {
                    const sysappId = modulos_pre[i].id_sysapp;
                    const sysmodId = modulos_pre[i].id_sysmod;
                    const syssubmodId = modulos_pre[i].id_syssubmod;

                    // Crear el objeto de la aplicación si no existe
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
                            mod_count: 0,
                            id_sysapp_type: modulos_pre[i].id_sysapp_type,
                            appcypher : idcypher,
                            modulos: {}
                        };
                    }

                    // Crear el módulo si no existe
                    if (!arr_modulos[sysappId].modulos[sysmodId]) {
                        arr_modulos[sysappId].mod_count++;
                        arr_modulos[sysappId].modulos[sysmodId] = {
                            id_mod: sysmodId,
                            mod_legend: modulos_pre[i].modulo_legend,
                            micon: modulos_pre[i].micon,
                            submod_count: 0,
                            submodulos: {} // Cambiar a un objeto
                        };
                    }

                    // Crear el submódulo si no existe
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
                arr_modulos = applyAdminGeneralMenuFilterIfNeeded(arr_modulos, req.usdata);
                req.usdata.usersInstanciaMenuAppId = getPreferredUsersInstanciaAppId(arr_modulos);
                Object.values(arr_modulos).forEach(app => {
                    if(app.mod_count===1) {
                        Object.values(app.modulos).forEach(modulo => {
                            if(modulo.submod_count===1) {
                                Object.values(modulo.submodulos).forEach( submod=> {
                                    if (isUsersInstanciaSubmod(submod)) return;
                                    arr_modulos[app.id].legend=submod.legend;
                                    arr_modulos[app.id].archivo=submod.archivo;
                                    arr_modulos[app.id].smicon=submod.smicon;
                                    arr_modulos[app.id].id_syssubmod=submod.id_syssubmod;
                                })
                            }
                        })
                    } else {
                        Object.values(app.modulos).forEach(modulo => {
                            if(modulo.submod_count===1) {
                                Object.values(modulo.submodulos).forEach( submod=> {
                                    if (isUsersInstanciaSubmod(submod)) return;
                                    arr_modulos[app.id].modulos[modulo.id_mod].legend=submod.legend;
                                    arr_modulos[app.id].modulos[modulo.id_mod].archivo=submod.archivo;
                                    arr_modulos[app.id].modulos[modulo.id_mod].smicon=submod.smicon;
                                    arr_modulos[app.id].modulos[modulo.id_mod].id_syssubmod=submod.id_syssubmod;
                                })
                            }
                        })
                    }
                });
                req.usdata.modulos = arr_modulos;

                // Permiso explícito para módulo de Hosting (ruta /hosting)
                const tieneHosting = Array.isArray(modulos_pre) && modulos_pre.some(m => {
                    const archivo = (m.archivo || '').toLowerCase();
                    return archivo === '/hosting' || archivo === 'hosting';
                });
                req.usdata.can_hosting = !!tieneHosting;

                // --- Instancia activa (para que el sidebar no "vuelva a la primera") ---
                // Muchos flows en el admin dependen del query `?i=<cypher>` (JWT) para resolver idapp.
                // Si por alguna redirección/recarga se pierde el query, recordamos la última instancia
                // en cookie para poder mantener contexto.
                const LAST_IDAPP_COOKIE = 'CMS_LAST_IDAPP';
                let idappSeleccionada = null;

                // 1) Preferir idapp desde query `i`
                if (req.query && req.query.i) {
                    try {
                        const decodedI = await promisify(jwt.verify)(req.query.i, process.env.SECRET);
                        if (decodedI && decodedI.idapp != null) {
                            const parsed = parseInt(decodedI.idapp, 10);
                            if (!isNaN(parsed)) {
                                idappSeleccionada = parsed;
                                res.cookie(LAST_IDAPP_COOKIE, String(parsed), {
                                    httpOnly: true,
                                    sameSite: 'lax',
                                    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
                                });
                            }
                        }
                    } catch (err) {
                        // No rompemos el flujo si el token viene inválido/expirado.
                    }
                }

                // 2) Fallback: cookie de la última instancia
                if (idappSeleccionada == null && req.cookies && req.cookies[LAST_IDAPP_COOKIE]) {
                    const parsed = parseInt(req.cookies[LAST_IDAPP_COOKIE], 10);
                    if (!isNaN(parsed)) idappSeleccionada = parsed;
                }

                req.usdata.idappSeleccionada = idappSeleccionada;
                req.usdata.rutaActual = req.path || '';
                /*req.usdata.modulos=[
                  {
                    'titulo': 'CAPTURAR FOTO',
                    'descripcion': 'Gestion de los usuarios de la Plataforma',
                    'picon': 'assets/img/menu/USUARIOS.svg',
                    'visible': true,
                    'rutas':[
                      '/capturaFoto',
                    ],
                    'ordenamiento': 1,
                    'f_reg': {
                      '$date': '2024-01-11T00:00:00.000Z'
                    }
                  }
                ];*/

                //req.datareg = datareg;
                return next();
            } else {
                if (clientExpectsJson(req)) {
                    return jsonSesionInvalida(res);
                }
                const host = req.get('host') || '';
                if (host.includes('localhost') || host.includes('127.0.0.1')) {
                    res.redirect('/admin');
                } else {
                    res.redirect('/');
                }
            }
        } catch (error) {
            console.error(error);
            if (clientExpectsJson(req)) {
                return jsonSesionInvalida(res);
            }
            const host = req.get('host') || '';
            if (host.includes('localhost') || host.includes('127.0.0.1')) {
                res.redirect('/admin');
            } else {
                res.redirect('/');
            }
        }
    } else {
        if (clientExpectsJson(req)) {
            return jsonSesionInvalida(res);
        }
        const host = req.get('host') || '';
        if (host.includes('localhost') || host.includes('127.0.0.1')) {
            res.redirect('/admin');
        } else {
            res.redirect('/');
        }
    }
}

async function isAuthJson(req, res, next){
    if (req.cookies[process.env.APP_COOKIE_NAME]) {
        try {
            const decoded = await promisify(jwt.verify)(req.cookies[process.env.APP_COOKIE_NAME], process.env.SECRET)
            userAdminModel.findOne({ _id: decoded.id_user })
                .then((data) => {
                    req.usdata = data
                    return next()
                }).catch((error) => {
                // console.log(error)
                res.json({success: false, msg: 'Su sesión ha finalizado', error: 1 });
            });
        } catch (error) {
            // console.log(error)
            res.json({success: false, msg: 'Su sesión ha finalizado ', error: 2 });
        }
    } else {
        res.json({success: false, msg: 'Su sesión ha finalizado', error: 3 });
    }
}
// async function verificarPermiso(req, res, next){
//     if(req.usdata.modulos.find(e=>e.rutas.includes(req.url))!=undefined){
//         return next();
//     } else {
//         res.redirect('/');
//     }
// }
async function campass(req, res, next){
    if(process.env.ACTIVE_DIRECTORY=='true'){
        return next();
    } else{
        if(req.usdata.campass==false){
            return res.render('psw');
        } else{
            return next();
        }
    }
}

function normalizeArchivoValue(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\/+$/, '');
}

function hasArchivoAccess(req, expectedArchivo) {
    const expected = normalizeArchivoValue(expectedArchivo);
    if (!expected) return false;
    const expectedNoSlash = expected.replace(/^\//, '');
    const apps = Object.values(req.usdata?.modulos || {});
    return apps.some((app) =>
        Object.values(app?.modulos || {}).some((modulo) =>
            Object.values(modulo?.submodulos || {}).some((submod) => {
                const archivo = normalizeArchivoValue(submod?.archivo);
                return archivo === expected || archivo === expectedNoSlash;
            })
        )
    );
}

function ensureSubmoduleAccess(expectedArchivo) {
    return function(req, res, next) {
        if (hasArchivoAccess(req, expectedArchivo)) return next();
        if (clientExpectsJson(req)) {
            return res.status(403).json({
                success: false,
                error: 1,
                message: 'No tienes acceso a este módulo.',
            });
        }
        return res.status(403).render('error', {
            ...(req.usdata || {}),
            title: 'Acceso restringido',
            msg: 'No tienes acceso a este módulo.',
        });
    };
}


module.exports = {
    isAuthenticated,
    isAuthJson,
    clientExpectsJson,
    // verificarPermiso,
    campass,
    hasArchivoAccess,
    ensureSubmoduleAccess,
}