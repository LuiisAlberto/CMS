// Tabla user_passkeys en BD central (PGDB_NAME_MAIN / sys_morena).
const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes } = require('sequelize');

const passkeysModel = dbConection.define('user_passkeys',
    {
        id_passkey: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        fk_id_user: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'users',
                key: 'id_user',
            },
            onDelete: 'CASCADE',
        },
        credential_id: {
            type: DataTypes.TEXT,
            allowNull: false,
            unique: true,
        },
        public_key: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        counter: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },
        device_name: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },
        f_reg: {
            type: 'TIMESTAMP WITHOUT TIME ZONE',
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        vigente: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
        },
    },
    {
        tableName: 'user_passkeys',
        timestamps: false,
    }
);

module.exports = passkeysModel;
