const { Sequelize } = require('sequelize');

require('dotenv').config();

const sequelize = new Sequelize(
    process.env.PGDB_NAME_MAIN,
    process.env.PGDB_USER,
    process.env.PGDB_PASSWORD,
    {
        host: process.env.PGDB_HOST,
        port: process.env.PGDB_PORT,
        dialect: 'postgres',
        logging: false,
        dialectOptions: {
            timezone: 'America/Mexico_City',
            useUTC: false
        },
        timezone: 'America/Mexico_City'
    }
);

// module.exports = sequelize;

// test connection
sequelize
    .authenticate()
    .then(() => {
        console.log('Conectado a Postgress main');
    })
    .catch((err) => {
        console.error('Error conectando a Postgress main', err);
        process.exit(1);
    });

module.exports = sequelize;
