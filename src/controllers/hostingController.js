const { Op } = require('sequelize');
const HostingModel = require('../models/HostingModel');
const sysappModel = require('../models/AppsModel');
const usersModel = require('../models/users');
const { enviarEmail } = require('../util/util');
const { registraBitacora, ACCION: BITACORA } = require('../util/bitacora');

/** Vista del Módulo de Hosting para Infra (usa modelos como wb_pagina con sysapp).
 * El acceso se controla vía permisos (can_hosting) y middleware de autenticación. */
async function hostingView(req, res) {
    try {
        const hostings = await HostingModel.findAll({
            where: {
                fk_id_estatus_hosting: {
                    [Op.ne]: 0 // Ocultar registros solo en estado Pendiente; se muestran en la vista de instancias
                }
            },
            include: [
                {
                    model: sysappModel,
                    as: 'instancia',
                    attributes: ['id_sysapp', 'sysapp_name', 'app_legend', 'urluri', 'vigente'],
                    required: false // Si la instancia fue eliminada (vigente=false), igual mostramos el hosting para "cancelar/avisar".
                },
                {
                    model: usersModel,
                    as: 'solicitante',
                    attributes: ['nombre', 'primer_apellido', 'segundo_apellido', 'email'],
                    required: false
                }
            ],
            order: [['f_solicitud', 'DESC']],
            raw: false
        });

        const listado = hostings.map(h => {
            const inst = h.instancia?.get ? h.instancia.get({ plain: true }) : h.instancia;
            const sol = h.solicitante?.get ? h.solicitante.get({ plain: true }) : h.solicitante;
            return {
                ...h.get({ plain: true }),
                sysapp_name: inst?.sysapp_name,
                app_legend: inst?.app_legend,
                urluri: inst?.urluri,
                instancia_vigente: inst?.vigente,
                solicitante_nombre: sol?.nombre,
                primer_apellido: sol?.primer_apellido,
                segundo_apellido: sol?.segundo_apellido,
                solicitante_email: sol?.email
            };
        });

        res.render('../views/hosting', {
            ...req.usdata,
            listado
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al cargar hosting' });
    }
}

/** Confirmar dominio: estatus 2 y notificación de dominio confirmado */
async function confirmarDominio(req, res) {
    try {
        const { id_hosting, dominio_asignado } = req.body;
        const id = parseInt(id_hosting, 10);
        if (!id || !dominio_asignado || !dominio_asignado.trim()) {
            return res.status(400).json({ success: false, message: 'ID y dominio asignado requeridos' });
        }

        const hosting = await HostingModel.findOne({ where: { id_hosting: id } });
        if (!hosting) return res.status(404).json({ success: false, message: 'Registro no encontrado' });
        if (hosting.fk_id_estatus_hosting === 2) {
            return res.status(400).json({ success: false, message: 'El dominio ya está confirmado' });
        }

        const dominio = dominio_asignado.trim();

        await hosting.update({
            fk_id_estatus_hosting: 2,
            dominio_asignado: dominio,
            validado_por: req.usdata.id_user,
            f_validacion: new Date()
        });

        await sysappModel.update(
            { urluri: dominio },
            { where: { id_sysapp: hosting.fk_id_sysapp } }
        );

        if (req.usdata && req.usdata.id_user) {
            void registraBitacora({
                fk_id_user_actor: req.usdata.id_user,
                accion: BITACORA.DOMINIO_CONFIRMADO,
                fk_id_sysapp: hosting.fk_id_sysapp,
                id_hosting: hosting.id_hosting,
                detalle: { dominio_asignado: dominio },
                req,
            });
        }

        const solicitante = await usersModel.findOne({ where: { id_user: hosting.solicitado_por }, raw: true });
        const instancia = await sysappModel.findOne({ where: { id_sysapp: hosting.fk_id_sysapp }, raw: true });
        const emailDestino = solicitante?.email;
        if (emailDestino) {
            await enviarEmail({
                to: emailDestino,
                to_name: solicitante ? [solicitante.nombre, solicitante.primer_apellido].filter(Boolean).join(' ') : 'Usuario',
                subject: `[CMS Morena] Dominio confirmado: ${instancia?.sysapp_name || 'Instancia'}`,
                body: `
                    <h3>El dominio de su instancia fue confirmado</h3>
                    <p>La instancia <strong>${instancia?.sysapp_name || 'N/A'}</strong> ya tiene asignado el dominio:</p>
                    <p><strong>${dominio}</strong></p>
                    <p>El estatus de hosting fue actualizado a "Con dominio".</p>
                `,
                isHTml: true
            });
        }

        return res.json({ success: true, message: 'Dominio confirmado y notificación enviada' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

/** Rechazar solicitud: estatus 3 */
async function rechazarDominio(req, res) {
    try {
        const { id_hosting, comentarios } = req.body;
        const id = parseInt(id_hosting, 10);
        if (!id) return res.status(400).json({ success: false, message: 'ID requerido' });

        const hosting = await HostingModel.findOne({ where: { id_hosting: id } });
        if (!hosting) return res.status(404).json({ success: false, message: 'Registro no encontrado' });

        await hosting.update({
            fk_id_estatus_hosting: 3,
            comentarios: (comentarios || '').trim()
        });

        const solicitante = await usersModel.findOne({ where: { id_user: hosting.solicitado_por }, raw: true });
        const instancia = await sysappModel.findOne({ where: { id_sysapp: hosting.fk_id_sysapp }, raw: true });
        const emailDestino = solicitante?.email;
        if (emailDestino) {
            await enviarEmail({
                to: emailDestino,
                to_name: solicitante ? [solicitante.nombre, solicitante.primer_apellido].filter(Boolean).join(' ') : 'Usuario',
                subject: `[CMS Morena] Solicitud de dominio rechazada: ${instancia?.sysapp_name || 'Instancia'}`,
                body: `
                    <h3>Su solicitud de dominio no fue aprobada</h3>
                    <p>La instancia <strong>${instancia?.sysapp_name || 'N/A'}</strong>.</p>
                    ${(comentarios || '').trim() ? `<p><strong>Comentarios:</strong> ${comentarios}</p>` : ''}
                `,
                isHTml: true
            });
        }

        return res.json({ success: true, message: 'Solicitud rechazada' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

/** Procesar baja: estatus 5 */
async function procesarBaja(req, res) {
    try {
        const { id_hosting } = req.body;
        const id = parseInt(id_hosting, 10);
        if (!id) return res.status(400).json({ success: false, message: 'ID requerido' });

        const hosting = await HostingModel.findOne({ where: { id_hosting: id } });
        if (!hosting) return res.status(404).json({ success: false, message: 'Registro no encontrado' });

        await hosting.update({
            fk_id_estatus_hosting: 5,
            f_baja: new Date()
        });

        // Cuando Infra confirme que el dominio ya se dio de baja:
        // marcar instancia como no vigente y no publicada.
        await sysappModel.update(
            { vigente: false, publicada: false },
            { where: { id_sysapp: hosting.fk_id_sysapp } }
        );

        return res.json({ success: true, message: 'Baja procesada' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

module.exports = {
    hostingView,
    confirmarDominio,
    rechazarDominio,
    procesarBaja
};
