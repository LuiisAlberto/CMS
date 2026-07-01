const dbConectionMain = require('../config/postgresMain');
const dbConection = require('../config/postgressdb');
const { Sequelize, DataTypes } = require('sequelize');
const storage_files = require('../models/storage_files');
const paginaModel = require("./paginasModel");
const { downloadImage } = require('../util/util');


const filesMain = dbConectionMain.define('files',
    {
        id_file: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        file_name: {
            type: DataTypes.STRING,
        },
        file_type: {
            type: DataTypes.STRING,
        },
        file_size: {
            type: DataTypes.INTEGER,
        },
        file_path: {
            type: DataTypes.STRING,
        },
        file_date:{
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        fk_id_storage: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'storage_filesModel',
                key: 'id_storage',
            },
            onDelete: 'RESTRICT',
        },
    },
    { tableName: 'files',
        timestamps: false }
);
const files = dbConection.define('files',
    {
        id_file: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        file_name: {
            type: DataTypes.STRING,
        },
        file_type: {
            type: DataTypes.STRING,
        },
        file_size: {
            type: DataTypes.INTEGER,
        },
        file_path: {
            type: DataTypes.STRING,
        },
        file_date:{
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        fk_id_storage: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'storage_filesModel',
                key: 'id_storage',
            },
            onDelete: 'RESTRICT',
        },
    },
    { tableName: 'files',
        timestamps: false }
);

const verFoto = async (file_path = '', file_id) => {
    try{
        let type = '';
        if(!file_path){
            const path = await files.findOne({
                where: {
                    id_file: file_id
                },
                raw: true,
            });

            file_path = path.file_path;
            type = path.file_type;
        }
        const imageBuffer = await downloadImage(process.env.PUBLIC_BUCKET_NAME, file_path);
        return {image: imageBuffer[0], type: type};
    }catch(error){
        console.log("[ERROR EN IMAGEN]: ", error);
        return false
    }
}

files.hasOne(paginaModel.pagina, { foreignKey: 'fk_id_file', as: 'archivo' });
paginaModel.pagina.belongsTo(files, { foreignKey: 'fk_id_file', as: 'archivo' });


storage_files.hasOne(files, { foreignKey: 'fk_id_storage', as: 'storage'  });
files.belongsTo(storage_files, { foreignKey: 'fk_id_storage', as: 'storage'  });

storage_files.hasOne(filesMain, { foreignKey: 'fk_id_storage', as: 'storageM'  });
filesMain.belongsTo(storage_files, { foreignKey: 'fk_id_storage', as: 'storageM'  });

files.hasOne(paginaModel.documento, { foreignKey: 'fk_id_file', as: 'archivodoc' });
paginaModel.documento.belongsTo(files, { foreignKey: 'fk_id_file', as: 'archivodoc' });

files.hasOne(paginaModel.imagen, { foreignKey: 'fk_id_file', as: 'archivoimg' });
paginaModel.imagen.belongsTo(files, { foreignKey: 'fk_id_file', as: 'archivoimg' });


module.exports ={
    files,
    filesMain,
    verFoto,
}