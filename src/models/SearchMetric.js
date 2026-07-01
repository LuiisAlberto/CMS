const dbConection = require('../config/postgresMain');
const { Sequelize, DataTypes } = require('sequelize');

/**
 * Métricas de Google Search Console almacenadas en BD.
 * Se alimentan con el job diario de sincronización (sync GSC → DB).
 * Cada fila = (instancia, fecha, página, consulta) con clicks, impresiones, posición, CTR.
 */
const SearchMetric = dbConection.define(
  'search_metric',
  {
    id_search_metric: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    fk_id_sysapp: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Instancia (sysapp) a la que pertenece la métrica',
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      comment: 'Fecha del dato (YYYY-MM-DD)',
    },
    page: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
      comment: 'URL de la página (dimension page de GSC)',
    },
    query: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
      comment: 'Consulta de búsqueda (dimension query de GSC)',
    },
    clicks: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    impressions: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    position: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Posición media',
    },
    ctr: {
      type: DataTypes.DECIMAL(10, 4),
      allowNull: true,
      comment: 'CTR (0–1)',
    },
    f_sync: {
      type: 'TIMESTAMP WITHOUT TIME ZONE',
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      comment: 'Última actualización desde GSC',
    },
  },
  {
    tableName: 'search_metric',
    createdAt: false,
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['fk_id_sysapp', 'date', 'page', 'query'], name: 'uq_search_metric_instance_date_page_query' },
      { fields: ['fk_id_sysapp', 'date'] },
      { fields: ['date'] },
    ],
  }
);

module.exports = SearchMetric;
