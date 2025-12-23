/**
 * Module de logging - Configuration de Winston pour les logs applicatifs
 *
 * Ce module configure Winston pour gérer les logs de l'application avec :
 * - Rotation quotidienne des fichiers de logs
 * - Différents niveaux de log (error, warn, info, debug)
 * - Format coloré pour la console en développement
 * - Format JSON pour les fichiers (facilite l'analyse)
 *
 * @module utils/logger
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Importer la configuration
const { config } = require('../config/env');

// Dossier des logs (à la racine du projet)
const LOG_DIR = path.join(__dirname, '../../logs');

/**
 * Format personnalisé pour les logs console
 * Affiche : [TIMESTAMP] [NIVEAU] Message
 */
const consoleFormat = winston.format.combine(
  // Ajouter des couleurs selon le niveau
  winston.format.colorize({ all: true }),
  // Ajouter le timestamp
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  // Format d'affichage personnalisé
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    // Construire le message avec les métadonnées si présentes
    let msg = `[${timestamp}] [${level}]: ${message}`;

    // Si des métadonnées sont présentes, les ajouter sur une nouvelle ligne
    if (Object.keys(metadata).length > 0) {
      msg += `\n   ${JSON.stringify(metadata, null, 2)}`;
    }

    return msg;
  })
);

/**
 * Format pour les fichiers de logs
 * Utilise JSON pour faciliter l'analyse et le parsing
 */
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Transport pour les logs combinés (tous les niveaux)
 * Rotation quotidienne avec rétention configurable
 */
const combinedTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true, // Compresser les anciens logs
  maxSize: '20m', // Taille max par fichier
  maxFiles: `${config.logging.retentionDays}d`, // Durée de rétention
  format: fileFormat,
});

/**
 * Transport pour les logs d'erreur uniquement
 * Fichier séparé pour faciliter le diagnostic des problèmes
 */
const errorTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: `${config.logging.retentionDays}d`,
  level: 'error', // Uniquement les erreurs
  format: fileFormat,
});

/**
 * Transport pour les logs des webhooks Shopify
 * Fichier dédié pour tracer toutes les commandes reçues
 */
const webhookTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'webhooks-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: `${config.logging.retentionDays}d`,
  format: fileFormat,
});

/**
 * Transport pour les logs de synchronisation stock
 * Fichier dédié pour tracer les mises à jour de stock
 */
const stockSyncTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'stock-sync-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: `${config.logging.retentionDays}d`,
  format: fileFormat,
});

/**
 * Logger principal de l'application
 */
const logger = winston.createLogger({
  level: config.logging.level,
  format: fileFormat,
  defaultMeta: { service: 'ophtalmic-middleware' },
  transports: [
    combinedTransport,
    errorTransport,
  ],
  // Ne pas crasher l'application sur une erreur de log
  exitOnError: false,
});

/**
 * En développement, afficher aussi les logs dans la console
 * avec un format coloré et lisible
 */
if (!config.server.isProduction) {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
  }));
}

/**
 * Logger dédié aux webhooks Shopify
 * Permet de tracer toutes les commandes reçues séparément
 */
const webhookLogger = winston.createLogger({
  level: 'info',
  format: fileFormat,
  defaultMeta: { service: 'shopify-webhook' },
  transports: [webhookTransport],
});

// Ajouter la console en développement
if (!config.server.isProduction) {
  webhookLogger.add(new winston.transports.Console({
    format: consoleFormat,
  }));
}

/**
 * Logger dédié à la synchronisation du stock
 * Permet de tracer toutes les opérations de sync séparément
 */
const stockSyncLogger = winston.createLogger({
  level: 'info',
  format: fileFormat,
  defaultMeta: { service: 'stock-sync' },
  transports: [stockSyncTransport],
});

// Ajouter la console en développement
if (!config.server.isProduction) {
  stockSyncLogger.add(new winston.transports.Console({
    format: consoleFormat,
  }));
}

/**
 * Fonction utilitaire pour créer un logger enfant avec contexte
 *
 * @param {string} module - Nom du module pour le contexte
 * @returns {Object} Logger avec le contexte du module
 *
 * @example
 * const log = createModuleLogger('sageX3Service');
 * log.info('Appel SOAP réussi', { stockQuantity: 100 });
 */
function createModuleLogger(module) {
  return logger.child({ module });
}

/**
 * Log d'un appel API entrant (middleware Express)
 *
 * @param {Object} req - Requête Express
 * @param {Object} res - Réponse Express
 * @param {Function} next - Fonction next
 */
function logRequest(req, res, next) {
  const startTime = Date.now();

  // Intercepter la fin de la réponse pour calculer la durée
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection.remoteAddress,
    };

    // Log niveau différent selon le code de statut
    if (res.statusCode >= 500) {
      logger.error('Requête HTTP', logData);
    } else if (res.statusCode >= 400) {
      logger.warn('Requête HTTP', logData);
    } else {
      logger.http('Requête HTTP', logData);
    }
  });

  next();
}

module.exports = {
  logger,
  webhookLogger,
  stockSyncLogger,
  createModuleLogger,
  logRequest,
};
