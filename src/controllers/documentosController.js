const filesModel = require('../models/files');
const paginaModel = require("../models/paginasModel");
const { Op,Sequelize, literal } = require('sequelize');
const {promisify} = require("util");
const jwt = require("jsonwebtoken");
const utilFun = require('../util/util')
const storage_files = require("../models/storage_files");
const {Storage} = require("@google-cloud/storage");
const Multer = require("multer");
const usersModel = require("../models/users");
const AppsModel = require("../models/AppsModel");
const {parse} = require("dotenv");

const storage = new Storage({
    projectId: process.env.PUBLIC_BUCKET_NAME,
    keyFilename: `certs/${process.env.PUBLIC_BUCKET_KEY}`
});
const storage_priv = new Storage({
    projectId: process.env.BUCKET_NAME,
    keyFilename: `certs/${process.env.BUCKET_KEY}`
});



const multerDoc = Multer({
    storage: Multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5mb
    },
});
const bucket = storage.bucket(process.env.PUBLIC_BUCKET_NAME);
const bucket_priv = storage_priv.bucket(process.env.BUCKET_NAME);


/** Vista modulo */
async function docsView(req, res){
    // Obtener idapp del token en query o de la cookie de sesión
    let idapp = null;
    let cypheridapp = req.query.i;
    
    if (cypheridapp) {
        try {
            const decoded = await promisify(jwt.verify)(cypheridapp, process.env.SECRET);
            if (decoded && decoded.idapp) {
                // Verificar fecha pero con mayor tolerancia (últimas 24 horas en lugar de solo el mismo día)
                const date_comp = new Date(decoded.date_comp);
                const date_now = new Date();
                const hoursDiff = Math.abs(date_now - date_comp) / 36e5; // Diferencia en horas
                
                // Permitir tokens de hasta 24 horas en lugar de solo el mismo día
                if (hoursDiff <= 24) {
                    idapp = decoded.idapp;
                }
            }
        } catch (error) {
            console.error('Error verificando token de query:', error);
        }
    }
    
    // Si no se pudo obtener del query, intentar desde la cookie de sesión
    if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
        try {
            const sessionToken = req.cookies[process.env.APP_COOKIE_NAME];
            const sessionDecoded = jwt.verify(sessionToken, process.env.SECRET);
            
            // Obtener idapp desde los módulos del usuario
            if (req.usdata && req.usdata.modulos) {
                // Buscar el idapp en los módulos del usuario
                const modulosArray = Object.values(req.usdata.modulos);
                if (modulosArray.length > 0) {
                    idapp = modulosArray[0].id; // Usar el primer módulo disponible
                    // Generar nuevo token para mantener compatibilidad
                    cypheridapp = jwt.sign(
                        {
                            idapp: idapp,
                            date_comp: new Date()
                        },
                        process.env.SECRET
                    );
                }
            }
        } catch (error) {
            console.error('Error obteniendo idapp de sesión:', error);
        }
    }
    
    // Si aún no hay idapp, redirigir a login
    if (!idapp) {
        return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
    }

    // cat_tags.fk_id_sysapp_type almacena id_sysapp (instancia), igual que en categorías e imágenes
    const tagsWhere = {
        fk_id_cat_type_tag: 1,
        vigente: true,
        [Op.or]: [
            { fk_id_sysapp_type: idapp },
            { fk_id_sysapp_type: null }
        ]
    };
    const tags = await paginaModel.cat_tags.findAll({
        where: tagsWhere,
        order: [['tag', 'asc']]
    });

    try{
        res.render('../views/documentos', {
            ...req.usdata,
            documentList: [],
            idcypher: cypheridapp,
            tags: tags
        })

    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}
async function imagenesView(req, res){
    // Obtener idapp del token en query o de la cookie de sesión
    let idapp = null;
    let idcypher = req.query.i;
    
    if (idcypher) {
        try {
            const decoded = await promisify(jwt.verify)(idcypher, process.env.SECRET);
            if (decoded && decoded.idapp) {
                // Verificar fecha pero con mayor tolerancia (últimas 24 horas en lugar de solo el mismo día)
                const date_comp = new Date(decoded.date_comp);
                const date_now = new Date();
                const hoursDiff = Math.abs(date_now - date_comp) / 36e5; // Diferencia en horas
                
                // Permitir tokens de hasta 24 horas en lugar de solo el mismo día
                if (hoursDiff <= 24) {
                    idapp = decoded.idapp;
                }
            }
        } catch (error) {
            console.error('Error verificando token de query:', error);
        }
    }
    
    // Si no se pudo obtener del query, intentar desde la cookie de sesión
    if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
        try {
            const sessionToken = req.cookies[process.env.APP_COOKIE_NAME];
            const sessionDecoded = jwt.verify(sessionToken, process.env.SECRET);
            
            // Obtener idapp desde los módulos del usuario
            if (req.usdata && req.usdata.modulos) {
                // Buscar el idapp en los módulos del usuario
                const modulosArray = Object.values(req.usdata.modulos);
                if (modulosArray.length > 0) {
                    idapp = modulosArray[0].id; // Usar el primer módulo disponible
                    // Generar nuevo token para mantener compatibilidad
                    idcypher = jwt.sign(
                        {
                            idapp: idapp,
                            date_comp: new Date()
                        },
                        process.env.SECRET
                    );
                }
            }
        } catch (error) {
            console.error('Error obteniendo idapp de sesión:', error);
        }
    }
    
    // Si aún no hay idapp, redirigir a login
    if (!idapp) {
        return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
    }

    const imageList = await paginaModel.imagen.findAll({
        attributes: [
            'id_wb_img','nombre', 'contenido_alt', 'fk_id_file','fk_id_cat_type_imgs','fk_id_user','f_publicacion',
            [Sequelize.literal(`"wb_imgs"."f_reg"::DATE`), 'f_reg_date']
        ],
        where: {
            fk_id_sysapp: idapp,
            vigente: true,
        },
        order: [
            ['f_publicacion', 'desc'],
        ],
        include: [
            {
                attributes: ['nombre','primer_apellido','segundo_apellido'],
                model: usersModel,
                as:'usuarioimg',
                required: false
            },
            {
                attributes: ['file_name','file_type','file_path'],
                model: filesModel.files,
                as:'archivoimg',
                required: false,
                include: [{
                    attributes: ['storage_path'],
                    model: storage_files,
                    as:'storage',
                    required: false
                }]
            },
            {
                model: paginaModel.cat_tags,
                through: {
                    where: { vigente: true },
                },
                required: false
            }
        ]
        // logging: console.log
    });

    const tagsWhereImg = {
        fk_id_cat_type_tag: 3,
        vigente: true,
        [Op.or]: [
            { fk_id_sysapp_type: idapp },
            { fk_id_sysapp_type: null }
        ]
    };
    const tags = await paginaModel.cat_tags.findAll({
        where: tagsWhereImg,
        order: [['tag', 'asc']]
    });

    for (const imagen of imageList) {
        imagen.idimgcy=jwt.sign(
            {
                id_wb_img: imagen.id_wb_img,
                idapp:idapp,
                date_comp: new Date()
            },
            process.env.SECRET
        );
    }

    try{
        res.render('../views/imagenes', {
            ...req.usdata,
            idcypher: idcypher,
            imageList:imageList,
            tags:tags
        })
    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function GetImages(req, res){
    // Obtener idapp del token en query o de la cookie de sesión
    let idapp = null;
    let cypheridapp = req.query.i;
    
    if (cypheridapp) {
        try {
            const decoded = await promisify(jwt.verify)(cypheridapp, process.env.SECRET);
            if (decoded && decoded.idapp) {
                // Verificar fecha pero con mayor tolerancia (últimas 24 horas)
                const date_comp = new Date(decoded.date_comp);
                const date_now = new Date();
                const hoursDiff = Math.abs(date_now - date_comp) / 36e5;
                
                if (hoursDiff <= 24) {
                    idapp = decoded.idapp;
                }
            }
        } catch (error) {
            console.error('Error verificando token de query:', error);
        }
    }
    
    // Si no se pudo obtener del token, intentar idapp explícito en query (ej. desde modal de edición)
    if (!idapp && req.query.idapp) {
        const idappQuery = parseInt(req.query.idapp, 10);
        if (!isNaN(idappQuery) && req.usdata && req.usdata.modulos) {
            const hasAccess = Object.values(req.usdata.modulos).some((m) => {
                if (!m || m.id == null) return false;
                const moduloId = parseInt(m.id, 10);
                return !isNaN(moduloId) && moduloId === idappQuery;
            });
            if (hasAccess) idapp = idappQuery;
        }
    }

    // Si aún no, intentar desde la cookie de sesión (primera app del usuario)
    if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
        try {
            const sessionToken = req.cookies[process.env.APP_COOKIE_NAME];
            jwt.verify(sessionToken, process.env.SECRET);
            if (req.usdata && req.usdata.modulos) {
                const modulosArray = Object.values(req.usdata.modulos);
                if (modulosArray.length > 0) {
                    idapp = modulosArray[0].id;
                }
            }
        } catch (error) {
            console.error('Error obteniendo idapp de sesión:', error);
        }
    }

    if (!idapp) {
        return res.status(401).json({ success: false, message: 'Petición vencida, por favor inicie sesión.' });
    }

    // Pagination params
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    // listFiles();

    try{
        const storageActivo = parseInt(process.env.PUBLIC_STORAGE_ACTIVE, 10);
        const storagePermitidos = [2];
        if (!isNaN(storageActivo) && !storagePermitidos.includes(storageActivo)) {
            storagePermitidos.push(storageActivo);
        }

        const whereClause = {
            fk_id_storage: { [Op.in]: storagePermitidos },
            file_type : {
                [Op.in]: ['image/png','image/jpeg']
            },
            [Op.and]: [
                literal(`(string_to_array(file_path, '/'))[2] = 'websites'`),
                literal(`(string_to_array(file_path, '/'))[3] = '${idapp}'`)
            ]
        };

        if (search) {
            whereClause.file_name = { [Op.iLike]: `%${search}%` };
        }

        const  { count, rows: files_img } = await filesModel.filesMain.findAndCountAll({
            where: whereClause,
            include: [{
                model: storage_files,
                as:'storageM',
                required: false
            }],
            order: [
                ['file_date', 'desc']
            ],
            limit: limit,
            offset: offset
        });

        for (const file of files_img) {
            const imagen = await paginaModel.imagen.findOne({
                where: { fk_id_file: file.id_file },
                include: [
                    {
                        model: paginaModel.cat_tags,
                        through: { attributes: [], where: { vigente: true } },
                        required: false,
                        attributes: ['id_cat_tag', 'tag']
                    }
                ]
            });
            let plain = imagen && imagen.get ? imagen.get({ plain: true }) : (imagen || null);
            // Respaldo: si el M2M no trae cat_tags (alias/joins), cargar por rel_wb_tag_img
            if (plain && plain.id_wb_img && (!plain.cat_tags || plain.cat_tags.length === 0)) {
                try {
                    const relRows = await paginaModel.rel_wb_tag_img.findAll({
                        where: { fk_id_wb_img: plain.id_wb_img, vigente: true },
                        attributes: ['fk_id_cat_tag'],
                        raw: true
                    });
                    const tagIds = [...new Set(relRows.map((r) => r.fk_id_cat_tag).filter(Boolean))];
                    if (tagIds.length > 0) {
                        const tags = await paginaModel.cat_tags.findAll({
                            where: { id_cat_tag: tagIds, vigente: true },
                            attributes: ['id_cat_tag', 'tag'],
                            raw: true
                        });
                        plain.cat_tags = tags;
                    }
                } catch (e) {
                    console.error('[GetImages] respaldo cat_tags:', e);
                }
            }
            file.dataValues.detalles = plain;
        }

        res.status(200).json({ 
            success: true, 
            message: 'Imágenes obtenidas',
            images:files_img,
            totalItems: count,
            totalPages: Math.ceil(count / limit),
            currentPage: page
        });

    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function GetDocs(req, res) {
    let idapp = null;
    let cypheridapp = req.query.i;

    if (cypheridapp) {
        try {
            const decoded = await promisify(jwt.verify)(cypheridapp, process.env.SECRET);
            if (decoded && decoded.idapp) {
                const date_comp = new Date(decoded.date_comp);
                const date_now = new Date();
                const hoursDiff = Math.abs(date_now - date_comp) / 36e5;
                if (hoursDiff <= 24) idapp = decoded.idapp;
            }
        } catch (error) {
            console.error('Error verificando token de query:', error);
        }
    }
    if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
        try {
            if (req.usdata && req.usdata.modulos) {
                const modulosArray = Object.values(req.usdata.modulos);
                if (modulosArray.length > 0) idapp = modulosArray[0].id;
            }
        } catch (error) {
            console.error('Error obteniendo idapp de sesión:', error);
        }
    }
    if (!idapp) {
        return res.status(401).json({ success: false, message: 'Petición vencida, por favor inicie sesión.' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const tagId = (req.query.tag != null && req.query.tag !== '' && !isNaN(parseInt(req.query.tag, 10)))
        ? parseInt(req.query.tag, 10) : null;

    const whereDoc = { fk_id_sysapp: idapp, vigente: true };
    if (search) {
        whereDoc[Op.and] = [
            { [Op.or]: [
                { nombre: { [Op.iLike]: '%' + search + '%' } },
                { contenido_alt: { [Op.iLike]: '%' + search + '%' } }
            ] }
        ];
    }

    const includes = [
        {
            attributes: ['nombre', 'primer_apellido', 'segundo_apellido'],
            model: usersModel,
            as: 'usuariodoc',
            required: false
        },
        {
            attributes: ['file_name', 'file_type', 'file_path'],
            model: filesModel.files,
            as: 'archivodoc',
            required: false,
            include: [{
                attributes: ['storage_path'],
                model: storage_files,
                as: 'storage',
                required: false
            }]
        },
        {
            model: paginaModel.cat_tags,
            through: { attributes: [], where: { vigente: true } },
            required: !!tagId,
            ...(tagId ? { where: { id_cat_tag: tagId } } : {}),
            attributes: ['id_cat_tag', 'tag']
        }
    ];

    try {
        const { count, rows: documentList } = await paginaModel.documento.findAndCountAll({
            attributes: ['id_wb_doc', 'nombre', 'contenido_alt', 'fk_id_file', 'fk_id_user', 'f_publicacion',
                [Sequelize.literal('"wb_docs"."f_reg"::DATE'), 'f_reg_date']
            ],
            where: whereDoc,
            order: [['f_publicacion', 'desc']],
            limit,
            offset,
            include: includes,
            distinct: true
        });

        const documents = documentList.map((doc) => {
            const iddoccy = jwt.sign(
                { id_wb_doc: doc.id_wb_doc, idapp: idapp, date_comp: new Date() },
                process.env.SECRET
            );
            const plain = doc.get ? doc.get({ plain: true }) : doc;
            return { ...plain, iddoccy };
        });

        res.status(200).json({
            success: true,
            documents,
            totalItems: count,
            totalPages: Math.ceil(count / limit),
            currentPage: page
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error' });
    }
}

async function CreateImg(req, res){
    try{
        // VALIDACIÓN
        let idapp = null;
        let cyphval = req.body.cyphval;
        
        if (cyphval) {
            try {
                const decoded = await promisify(jwt.verify)(cyphval, process.env.SECRET);
                if (decoded && decoded.idapp) {
                    // Verificar fecha pero con mayor tolerancia (últimas 24 horas)
                    const date_comp = new Date(decoded.date_comp);
                    const date_now = new Date();
                    const hoursDiff = Math.abs(date_now - date_comp) / 36e5;
                    
                    if (hoursDiff <= 24) {
                        idapp = decoded.idapp;
                    }
                }
            } catch (error) {
                console.error('Error verificando token:', error);
            }
        }
        
        // Si no se pudo obtener del token, intentar desde la cookie de sesión
        if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
            try {
                const sessionToken = req.cookies[process.env.APP_COOKIE_NAME];
                const sessionDecoded = jwt.verify(sessionToken, process.env.SECRET);
                
                if (req.usdata && req.usdata.modulos) {
                    const modulosArray = Object.values(req.usdata.modulos);
                    if (modulosArray.length > 0) {
                        idapp = modulosArray[0].id;
                        // Generar nuevo token para mantener compatibilidad
                        cyphval = jwt.sign(
                            {
                                idapp: idapp,
                                date_comp: new Date()
                            },
                            process.env.SECRET
                        );
                    }
                }
            } catch (error) {
                console.error('Error obteniendo idapp de sesión:', error);
            }
        }
        
        // Si aún no hay idapp, retornar error
        if (!idapp) {
            return res.status(401).json({ success: false, message: 'Petición vencida, por favor inicie sesión.' });
        }

        // console.log(req.body);

        const token = req.cookies[process.env.APP_COOKIE_NAME];
        const usuario = jwt.verify(token, process.env.SECRET);
        const id_user = usuario.id_user;

        // BÁSICOS
        let errores=[];

        const tipo_tag_raw = req.body.tipo_tag;
        const tipo_tag = (tipo_tag_raw !== undefined && tipo_tag_raw !== '' && !isNaN(parseInt(tipo_tag_raw, 10)))
            ? parseInt(tipo_tag_raw, 10) : null;
        if (tipo_tag == null || tipo_tag <= 0) {
            errores.push('Seleccione una categoría de imagen.');
        } else {
            const tagImg = await paginaModel.cat_tags.findOne({
                where: { id_cat_tag: tipo_tag, vigente: true },
                attributes: ['fk_id_cat_type_tag', 'fk_id_sysapp_type'],
                raw: true
            });
            if (!tagImg || tagImg.fk_id_cat_type_tag !== 3) {
                errores.push('La categoría de imagen seleccionada no es válida.');
            } else if (tagImg.fk_id_sysapp_type != null && tagImg.fk_id_sysapp_type !== parseInt(idapp, 10)) {
                errores.push('La categoría de imagen no corresponde a su instancia.');
            }
        }

        if (req.file && errores.length === 0) {
            let filename = 'cdn/websites/' + idapp + '/' + req.file.originalname;
            const blob = bucket.file(filename);
            const blobStream = blob.createWriteStream();

            blobStream.on("finish", () => {
                filesModel.filesMain.create({
                    file_name: req.file.originalname,
                    file_type: req.file.mimetype,
                    file_size: req.file.size,
                    file_path: filename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                }).then(fileCreado => {
                    const idFile = fileCreado.id_file;
                    paginaModel.imagen.create({
                        fk_id_file: idFile,
                        nombre: req.body.nameimg,
                        contenido_alt: req.body.descriptionimg,
                        fk_id_cat_type_imgs: null,
                        fk_id_user: id_user,
                        fk_id_sysapp: idapp,
                        vigente: true,
                    }).then(imagenCreada => {
                        if (tipo_tag != null && tipo_tag > 0) {
                            paginaModel.rel_wb_tag_img.create({
                                fk_id_cat_tag: tipo_tag,
                                fk_id_wb_img: imagenCreada.id_wb_img,
                                fk_id_user: id_user,
                                vigente: true
                            }).then(() => {
                                res.status(200).json({ success: true, message: 'Imagen guardada correctamente' });
                            }).catch(error => {
                                console.error('Error al insertar el tag en la imagen en la base de datos:', error);
                                res.status(500).json({ success: false, error: 1, message: 'Error al insertar el tag en la imagen en la base de datos' });
                            });
                        } else {
                            res.status(200).json({ success: true, message: 'Imagen guardada correctamente' });
                        }
                    });
                }).catch(error => {
                    console.error('Error al insertar el archivo o la página en la base de datos:', error);
                    res.status(500).json({ success: false, error: 1, message: 'Error al insertar el archivo en la base de datos' });
                });
            });

            blobStream.on('error', (err) => {
                console.error('Error al cargar el imagen:', err);
                res.status(500).json({ success: false, error: 1, message: 'Error al cargar el archivo' });
            });

            blobStream.end(req.file.buffer);
        }  else if (errores.length===0){
            errores.push('No se subió imagen');
        }

        if (errores.length>0){
            let htmlerro = '<ul>';
            errores.forEach(error => {
                htmlerro += `<li>${error}</li>`;
            });
            htmlerro += '</ul>';
            let erroreshtml='<p>Por favor valida estos datos</p>' + htmlerro;
            res.status(200).json({ success: false, error: 1, message: erroreshtml });
        }
    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function DeleteImg(req, res) {
    try {
        const id_file = parseInt(req.body.id_file, 10);
        if (!id_file || isNaN(id_file)) {
            return res.status(400).json({ success: false, error: 1, message: 'ID de imagen inválido.' });
        }
        let idapp = null;
        const cyphval = req.body.cyphval || req.body.i;
        if (cyphval) {
            try {
                const decoded = await promisify(jwt.verify)(cyphval, process.env.SECRET);
                if (decoded && decoded.idapp) idapp = decoded.idapp;
            } catch (e) {}
        }
        if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
            try {
                const sessionDecoded = jwt.verify(req.cookies[process.env.APP_COOKIE_NAME], process.env.SECRET);
                if (req.usdata && req.usdata.modulos && Object.values(req.usdata.modulos).length) {
                    idapp = Object.values(req.usdata.modulos)[0].id;
                }
            } catch (e) {}
        }
        if (!idapp) {
            return res.status(401).json({ success: false, error: 1, message: 'Petición vencida, inicie sesión.' });
        }

        const fileRow = await filesModel.filesMain.findOne({
            where: { id_file },
            include: [{ model: storage_files, as: 'storageM', required: false }],
            raw: true
        });
        if (!fileRow || !fileRow.file_path) {
            return res.status(404).json({ success: false, error: 1, message: 'Imagen no encontrada.' });
        }
        const pathParts = (fileRow.file_path || '').split('/');
        // file_path suele ser "cdn/websites/{idapp}/..." -> pathParts[1]==='websites', pathParts[2]===idapp
        if (pathParts[1] !== 'websites' || pathParts[2] !== String(idapp)) {
            return res.status(403).json({ success: false, error: 1, message: 'No puede eliminar esta imagen.' });
        }

        const imagenRow = await paginaModel.imagen.findOne({ where: { fk_id_file: id_file }, raw: true });
        if (imagenRow) {
            await paginaModel.rel_wb_tag_img.update(
                { vigente: false, f_no_vigente: new Date() },
                { where: { fk_id_wb_img: imagenRow.id_wb_img } }
            );
            await paginaModel.imagen.update(
                { vigente: false, f_no_vigente: new Date() },
                { where: { id_wb_img: imagenRow.id_wb_img } }
            );
        }

        const moved = await moveFile(fileRow.file_path);
        if (moved) {
            await filesModel.filesMain.update(
                { fk_id_storage: 1 },
                { where: { id_file } }
            );
            return res.status(200).json({ success: true, message: 'Imagen eliminada correctamente.' });
        }
        return res.status(500).json({ success: false, error: 1, message: 'Error al mover el archivo.' });
    } catch (error) {
        console.error('[DeleteImg]', error);
        return res.status(500).json({ success: false, error: 1, message: 'Error al eliminar la imagen.' });
    }
}

async function CreateDoc(req, res){

    try{

        // VALIDACIÓN
        let idapp = null;
        let cyphval = req.body.cyphval;
        
        if (cyphval) {
            try {
                const decoded = await promisify(jwt.verify)(cyphval, process.env.SECRET);
                if (decoded && decoded.idapp) {
                    // Verificar fecha pero con mayor tolerancia (últimas 24 horas)
                    const date_comp = new Date(decoded.date_comp);
                    const date_now = new Date();
                    const hoursDiff = Math.abs(date_now - date_comp) / 36e5;
                    
                    if (hoursDiff <= 24) {
                        idapp = decoded.idapp;
                    }
                }
            } catch (error) {
                console.error('Error verificando token:', error);
            }
        }
        
        // Si no se pudo obtener del token, intentar desde la cookie de sesión
        if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
            try {
                const sessionToken = req.cookies[process.env.APP_COOKIE_NAME];
                const sessionDecoded = jwt.verify(sessionToken, process.env.SECRET);
                
                if (req.usdata && req.usdata.modulos) {
                    const modulosArray = Object.values(req.usdata.modulos);
                    if (modulosArray.length > 0) {
                        idapp = modulosArray[0].id;
                        // Generar nuevo token para mantener compatibilidad
                        cyphval = jwt.sign(
                            {
                                idapp: idapp,
                                date_comp: new Date()
                            },
                            process.env.SECRET
                        );
                    }
                }
            } catch (error) {
                console.error('Error obteniendo idapp de sesión:', error);
            }
        }
        
        // Si aún no hay idapp, retornar error
        if (!idapp) {
            return res.status(401).json({ success: false, message: 'Petición vencida, por favor inicie sesión.' });
        }

        const token = req.cookies[process.env.APP_COOKIE_NAME];
        const usuario = jwt.verify(token, process.env.SECRET);
        const id_user = usuario.id_user;

        // BÁSICOS
        let errores=[];

        let iddoc=parseInt(req.body.iddoc);
        let iedicion=parseInt(req.body.iedicion);
        let archivonuevo=parseInt(req.body.archivonuevo);

        let namepag=req.body.namepag;
        if(namepag==='') {
            errores.push('El nombre no puede estar vacío');
        }
        let descdoc=req.body.descdoc;
        if(descdoc==='') {
            errores.push('Escribe una descripción del archivo');
        }

        let tipo_tag=parseInt(req.body.tipo_tag);
        if(tipo_tag===0) {
            errores.push('Seleccione un tipo de documento');
        }
        if (tipo_tag > 0) {
            const tagDoc = await paginaModel.cat_tags.findOne({
                where: { id_cat_tag: tipo_tag, vigente: true },
                attributes: ['fk_id_cat_type_tag', 'fk_id_sysapp_type'],
                raw: true
            });
            const idappNum = parseInt(idapp, 10);
            if (!tagDoc || tagDoc.fk_id_cat_type_tag !== 1) {
                errores.push('El tipo de documento seleccionado no es válido.');
            } else if (tagDoc.fk_id_sysapp_type != null && tagDoc.fk_id_sysapp_type !== idappNum) {
                errores.push('El tipo de documento no corresponde a su instancia.');
            }
        }

        // fecha de publicación
        let f_pub=new Date(req.body.f_pub)
        let f_pub_or=req.body.f_pub.replace('Z', '')
        const hoy = new Date();
        hoy.setDate(hoy.getDate() - 7);

        const semanaFutura = new Date();
        semanaFutura.setDate(hoy.getDate() + 7);
        const fechaHoy = hoy.toISOString().split('T')[0];
        const fechaSemanaFutura = semanaFutura.toISOString().split('T')[0];
        if (f_pub < fechaHoy || f_pub > fechaSemanaFutura) {
            errores.push('La fecha no puede ser ni menor, ni mayor a 7 días de la fecha actual');
        }

        // Tipos de archivo permitidos: PDF, Word, Excel (.xlsx)
        if (req.file) {
            const fname = (req.file.originalname || '').toLowerCase();
            const allowedExt = /\.(pdf|doc|docx|xlsx)$/i.test(fname);
            const allowedMime = new Set([
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/octet-stream'
            ]);
            const mime = (req.file.mimetype || '').toLowerCase();
            const xlsxZip = fname.endsWith('.xlsx') && mime === 'application/zip';
            if (!allowedExt) {
                errores.push('Solo se permiten archivos PDF, Word (.doc, .docx) o Excel (.xlsx).');
            } else if (mime && !allowedMime.has(mime) && !xlsxZip) {
                errores.push('Tipo de archivo no permitido.');
            }
        }

        if (iedicion===0 && req.file && errores.length===0) {

            let filename = 'cdn/websites_docs/' + idapp + '/' + req.file.originalname;
            const blob = bucket.file(filename);
            const blobStream = blob.createWriteStream();

            blobStream.on("finish", () => {
                filesModel.filesMain.create({
                    file_name: req.file.originalname,
                    file_type: req.file.mimetype,
                    file_size: req.file.size,
                    file_path: filename,
                    fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
                }).then(fileCreado => {
                    const idFile = fileCreado.id_file;
                    paginaModel.documento.create({
                        nombre : namepag,
                        contenido_alt : descdoc,
                        fk_id_file : idFile,
                        //fk_id_cat_type_docs : 1,
                        fk_id_user : id_user,
                        fk_id_sysapp : idapp,
                        f_publicacion : f_pub_or
                    }).then(docscreado => {
                        paginaModel.rel_wb_tag_doc.create({
                            fk_id_cat_tag: tipo_tag,
                            fk_id_wb_doc : docscreado.id_wb_doc,
                            fk_id_user : id_user
                        }).then(rel_cre => {
                            // console.log(rel_cre.id_rel_wb_tag_doc);
                            res.status(200).json({ success: true,  message: 'Archivo cargado correctamente' });
                        }).catch(error => {
                            console.error('Error al insertar el tag en el archivo en la base de datos:', error);
                            res.status(500).json({ success: false, error: 1, message: 'Error al insertar el archivo en la base de datos' });
                        });
                    }).catch(error => {
                        console.error('Error al insertar wb_docs en la base de datos:', error);
                        res.status(500).json({ success: false, error: 1, message: 'Error al insertar el archivo en la base de datos' });
                    });
                }).catch(error => {
                    console.error('Error al insertar el archivo en la base de datos:', error);
                    res.status(500).json({ success: false, error: 1, message: 'Error al insertar el archivo en la base de datos' });
                });
            });

            blobStream.on('error', (err) => {
                console.error('Error al cargar el archivo:', err);
                res.status(500).json({ success: false, error: 1, message: 'Error al cargar el archivo' });
            });

            blobStream.end(req.file.buffer);

        }  else if (iedicion===1 && errores.length===0 && archivonuevo===0){

            const docup= await paginaModel.documento.update({
                    nombre : namepag,
                    contenido_alt : descdoc,
                    fk_id_user : id_user,
                    f_publicacion : f_pub_or
                },{
                    where:{id_wb_doc:iddoc}
                }
            );

            const tag= await paginaModel.rel_wb_tag_doc.update({
                    fk_id_cat_tag: tipo_tag
                },{
                    where: {fk_id_wb_doc:iddoc}
                }
            );
            res.status(200).json({ success: true,  message: 'Archivo cargado correctamente' });

        }  else if (iedicion===1 && errores.length===0 && archivonuevo===1 && req.file){

            let filename = 'cdn/websites_docs/' + idapp + '/' + req.file.originalname;
            const blob = bucket.file(filename);
            const blobStream = blob.createWriteStream();

            await new Promise((resolve, reject) => {
                blobStream.on("finish", resolve);
                blobStream.on("error", reject);
                blobStream.end(req.file.buffer);
            });

            const file = await filesModel.filesMain.create({
                file_name: req.file.originalname,
                file_type: req.file.mimetype,
                file_size: req.file.size,
                file_path: filename,
                fk_id_storage: process.env.PUBLIC_STORAGE_ACTIVE
            });

            const idFile = file.id_file;

            const docup= await paginaModel.documento.update({
                    nombre : namepag,
                    contenido_alt : descdoc,
                    fk_id_file : idFile,
                    f_publicacion : f_pub_or
                },{
                    where:{id_wb_doc:iddoc}
                }
            );

            const tag= await paginaModel.rel_wb_tag_doc.update({
                    fk_id_cat_tag: tipo_tag
                },{
                    where: {fk_id_wb_doc:iddoc}
                }
            );
            res.status(200).json({ success: true,  message: 'Archivo cargado correctamente' });

        }  else if (errores.length===0 && archivonuevo!==0){
            errores.push('No se subió documento');
        }

        if (errores.length>0){
            let htmlerro = '<ul>';
            errores.forEach(error => {
                htmlerro += `<li>${error}</li>`;
            });
            htmlerro += '</ul>';
            let erroreshtml='<p>Por favor valida estos datos</p>' + htmlerro;
            res.status(200).json({ success: false, error: 1, message: erroreshtml });
        }


    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function listFiles() {
    try {
        const [files] = await bucket.getFiles();
        //console.log('Archivos en el bucket:');
        files.forEach(file => {
            console.log(file.name);
        });
    } catch (error) {
        console.error('Error al listar los archivos:', error);
    }
}
async function GetDoc(req, res){
    let id_wb_doc = null;
    let idapp = null;
    let cypher = req.body.cy;
    
    if (cypher) {
        try {
            const decoded = await promisify(jwt.verify)(cypher, process.env.SECRET);
            if (decoded) {
                // Verificar fecha pero con mayor tolerancia (últimas 24 horas)
                const date_comp = new Date(decoded.date_comp);
                const date_now = new Date();
                const hoursDiff = Math.abs(date_now - date_comp) / 36e5;
                
                if (hoursDiff <= 24 && decoded.id_wb_doc && decoded.idapp) {
                    id_wb_doc = decoded.id_wb_doc;
                    idapp = decoded.idapp;
                }
            }
        } catch (error) {
            console.error('Error verificando token:', error);
        }
    }
    
    // Si no se pudo obtener del token, intentar desde la cookie de sesión
    if (!idapp && req.cookies && req.cookies[process.env.APP_COOKIE_NAME]) {
        try {
            const sessionToken = req.cookies[process.env.APP_COOKIE_NAME];
            const sessionDecoded = jwt.verify(sessionToken, process.env.SECRET);
            
            if (req.usdata && req.usdata.modulos) {
                const modulosArray = Object.values(req.usdata.modulos);
                if (modulosArray.length > 0) {
                    idapp = modulosArray[0].id;
                }
            }
            
            // Si tenemos idapp pero no id_wb_doc, intentar obtenerlo del body
            if (idapp && !id_wb_doc && req.body.id_wb_doc) {
                id_wb_doc = parseInt(req.body.id_wb_doc);
            }
        } catch (error) {
            console.error('Error obteniendo datos de sesión:', error);
        }
    }
    
    // Si aún no hay datos necesarios, retornar error
    if (!idapp || !id_wb_doc) {
        return res.status(401).json({ success: false, message: 'Petición vencida, por favor inicie sesión.' });
    }

    try{
        const doc = await paginaModel.documento.findOne({
            where: { id_wb_doc: id_wb_doc, fk_id_sysapp: idapp, vigente: true },
            include: [
                {
                    attributes: ['file_name', 'file_type', 'file_path'],
                    model: filesModel.files,
                    as: 'archivodoc',
                    required: false,
                    include: [{
                        attributes: ['storage_path'],
                        model: storage_files,
                        as: 'storage',
                        required: false
                    }]
                },
                {
                    model: paginaModel.cat_tags,
                    through: { where: { vigente: true } },
                    required: false
                }
            ]
        });

        if (!doc) {
            return res.status(404).json({ success: false, message: 'Documento no encontrado o no pertenece a esta instancia.' });
        }

        const plain = doc.get ? doc.get({ plain: true }) : doc;
        res.status(200).json({ success: true, message: 'Doc obtenido', doc: plain });
    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function DeleteDoc(req, res){
    try{

        let cypher=req.body.cy;
        const decoded = await promisify(jwt.verify)(cypher, process.env.SECRET);
        if (!decoded) throw new Error('Alerta en jwt en petición ')
        let comparedates=utilFun.compareDates(decoded.date_comp)
        if(!comparedates) return res.redirect("/?error= Petición vencida, por favor inicie sesión.");
        let id_wb_doc=decoded.id_wb_doc;
        let idapp=decoded.idapp;

        const pagactu= await paginaModel.documento.update(
            {
                f_no_vigente: new Date(),
                vigente: false
            },
            {
                where: {
                    id_wb_doc: id_wb_doc
                }
            }
        )
        const docs = await paginaModel.documento.findOne( {
                where: {id_wb_doc:id_wb_doc},
                include: [
                    {
                        attributes: ['file_name','file_type','file_path'],
                        model: filesModel.files,
                        as:'archivodoc',
                        required: false,
                        include: [{
                            attributes: ['storage_path'],
                            model: storage_files,
                            as:'storage',
                            required: false
                        }]
                    },
                    {
                        model: paginaModel.cat_tags,
                        through: {
                            where: { vigente: true },
                        },
                        required: false
                    }
                ],

                raw:true
            },
        );
        // console.log(docs['archivodoc.file_path'])
        const mov=await moveFile(docs['archivodoc.file_path'])
        if(mov) {
            const filemov = await filesModel.files.update({
                    fk_id_storage:1
                },
                {
                    where: {id_file:docs.fk_id_file}
                }
            )
            res.status(200).json({ success: true, message: 'Documento eliminado'});
        } else {
            throw new Error('Error al mover archivo')
        }

    } catch (error){
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

function isGcsNotFoundError(error) {
    if (!error) return false;
    if (error.code === 404 || Number(error.code) === 404) return true;
    if (error.errors && error.errors[0] && error.errors[0].reason === 'notFound') return true;
    const msg = String(error.message || '');
    return msg.includes('No such object') || msg.includes('Not Found');
}

async function moveFile(sourceFileName) {
    try {
        const sourceFile = bucket.file(sourceFileName);
        const [exists] = await sourceFile.exists();
        if (!exists) {
            console.warn(
                `[moveFile] No existe en bucket público (omitido): ${sourceFileName}`
            );
            return true;
        }

        await sourceFile.copy(bucket_priv.file(sourceFileName));
        console.log(`Archivo copiado`);

        await sourceFile.delete();

        const [stillThere] = await bucket.file(sourceFileName).exists();
        if (stillThere) {
            console.error('¡El archivo sigue existiendo a pesar de intentar eliminarlo!');
            throw new Error('No se eliminó');
        }
        console.log(`Archivo original eliminado del bucket público`);
        return true;
    } catch (error) {
        if (isGcsNotFoundError(error)) {
            console.warn(
                `[moveFile] Objeto no encontrado en GCS; se asume ya inexistente: ${sourceFileName}`
            );
            return true;
        }
        console.error('Error al mover el archivo:', error);
        return false;
    }
}

module.exports = {
    docsView,
    imagenesView,
    GetImages,
    GetDocs,
    multerDoc,
    CreateImg,
    DeleteImg,
    CreateDoc,
    GetDoc,
    DeleteDoc
}
