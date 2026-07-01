const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes, QueryTypes } = require('sequelize');
const paginaModel = require('../models/paginasModel');

const usersModel = dbConection.define('users',
    {
        id_user: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        uname: {
            type: DataTypes.STRING,
        },
        upass: {
            type: DataTypes.STRING,
        },
        fk_id_cat_type_users: {
            type: DataTypes.INTEGER,
            //allowNull: false,
            references: {
                model: 'cat_type_users',
                key: 'id_cat_type_users',
            },
            onDelete: 'RESTRICT',
        },
        nombre: {
            type: DataTypes.STRING,
        },
        primer_apellido: {
            type: DataTypes.STRING,
        },
        segundo_apellido: {
            type: DataTypes.STRING,
        },
        email: {
            type: DataTypes.STRING,
        },
        telefono_fijo: {
            type: DataTypes.STRING,
        },
        telefono_celular: {
            type: DataTypes.STRING,
        },
        curp: {
            type: DataTypes.STRING,
        },
        rfc: {
            type: DataTypes.STRING,
        },
        fk_id_estado: {
            type: DataTypes.INTEGER,
        },
        fk_id_municipio: {
            type: DataTypes.INTEGER,
        },
        campass: {
            type: DataTypes.BOOLEAN,
        },
        activo: {
            type: DataTypes.BOOLEAN,
        },
        f_activo: {
            type: 'TIMESTAMP',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        vigente:{
            type: DataTypes.BOOLEAN,
        },
    },
    {
        createdAt: false,
        updatedAt: false,
    }
);
usersModel.hasOne(paginaModel.pagina, { foreignKey: 'fk_id_user', as: 'usuario' });
paginaModel.pagina.belongsTo(usersModel, { foreignKey: 'fk_id_user', as: 'usuario' });

usersModel.hasOne(paginaModel.documento, { foreignKey: 'fk_id_user', as: 'usuariodoc' });
paginaModel.documento.belongsTo(usersModel, { foreignKey: 'fk_id_user', as: 'usuariodoc' });

usersModel.hasOne(paginaModel.imagen, { foreignKey: 'fk_id_user', as: 'usuarioimg' });
paginaModel.imagen.belongsTo(usersModel, { foreignKey: 'fk_id_user', as: 'usuarioimg'})


usersModel.valUser = async (email,usuario) => {
    try {
        const result= await dbConection.query(
            'SELECT count(*) as total FROM users where email=$1 or uname=$2',
            {
                bind: [
                    email,
                    usuario,
                ],
                type: QueryTypes.SELECT,
            }
        );
        // console.log(result);
        return result[0].total > 0;
    } catch (error) {
        console.error(error);
        return false;
    }
};


usersModel.updateUser = async (data) => {

    let id_user = data.id_user;
    let email = data.email;
    let telefono_celular = data.telefono_celular;
    let telefono_fijo = data.telefono_fijo;
    let permisos = data.permisos;
    let permisosUsuario = data.permisosUsuario;
    let todosPermisosPresentes = data.todosPermisosPresentes;


    await dbConection.query('BEGIN;');
    try {
        // Consulta para actualizar datos en la tabla de usuarios
        const actualizarTablaUsuarios = await dbConection.query(
            `UPDATE users SET email=$2, telefono_celular=$3, telefono_fijo=$4 WHERE id_user=$1`,
            {
                bind: [id_user, email, telefono_celular, telefono_fijo],
                type: QueryTypes.UPDATE,
            }
        );


        // Al menos un permiso del usuario no está presente en los permisos
        if ( todosPermisosPresentes == false ){
            // Consulta para actualizar los módulos antiguos
            const actualizarModulosAntiguos = await dbConection.query(
                `UPDATE sys_perm SET vigente=false, f_no_vigente=NOW() WHERE fk_id_user=$1`,
                {
                    bind: [id_user],
                    type: QueryTypes.UPDATE,
                }
            );
            // Consulta para insertar nuevos módulos}
            const registrarNuevosModulos = await dbConection.query(
                `INSERT INTO sys_perm(fk_id_user,fk_id_syssubmod)
                 SELECT $1, fk_id_syssubmod
                 FROM syssubmod
                 WHERE fk_id_syssubmod IN(${permisos}) AND visible=true
                 ORDER BY id_sub_modulo`,
                {
                    bind: [id_user],
                    type: QueryTypes.INSERT,
                }
            );
        }

        console.log('Actualizacion guardada');
        await dbConection.query('COMMIT;');
        return true;
    } catch (error) {
        console.error(error);
        await dbConection.query('ROLLBACK;');
        return false;
    }
};



module.exports =    usersModel;
