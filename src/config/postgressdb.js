// const { Client } = require( 'pg');

// const connPGDB = async () => {
//     try {
//         const client = new Client({
//             host: process.env.PGDB_HOST,
//             port: process.env.PGDB_PORT,
//             database: process.env.PGDB_NAME,
//             user: process.env.PGDB_USER,
//             password: process.env.PGDB_PASSWORD,
//           })
//           await client.connect()

//         console.log('Conectado a Postgress');
//         return client;
//     } catch (error) {
//         console.error('Error conectando a Postgress', err);
//         process.exit(1); 
//     }
// };

// module.exports = connPGDB;

const { Sequelize } = require('sequelize');

require('dotenv').config();

const sequelize = new Sequelize(
    process.env.PGDB_NAME,
    process.env.PGDB_USER,
    process.env.PGDB_PASSWORD,
    {
        host: process.env.PGDB_HOST,
        port: process.env.PGDB_PORT,
        dialect: 'postgres',
        dialectOptions: {
            timezone: 'America/Mexico_City',
            useUTC: false,
        },
        timezone: 'America/Mexico_City',
        logging: false,
        define: {
            freezeTableName: true,
        }
    },

);

// module.exports = sequelize;

// test connection
sequelize
    .authenticate()
    .then(() => {
        console.log('Conectado a Postgress');
    })
    .catch((err) => {
        console.error('Error conectando a Postgress', err);
        process.exit(1);
    });

module.exports = sequelize;
