/**
 * Service SFTP - Client pour l'envoi de fichiers sur le serveur SFTP
 *
 * Ce service gère la connexion et les opérations SFTP :
 * - Connexion/déconnexion sécurisée
 * - Upload de fichiers
 * - Liste des fichiers/dossiers
 * - Création de dossiers
 *
 * @module services/sftpService
 */

const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');

// Logger dédié à ce module
const log = createModuleLogger('sftpService');

/**
 * Crée et retourne une nouvelle instance de client SFTP
 *
 * @returns {SftpClient} Nouvelle instance de client SFTP
 */
function createSftpClient() {
  return new SftpClient();
}

/**
 * Configuration de connexion SFTP
 * Extraite de la configuration globale
 */
function getSftpConfig() {
  return {
    host: config.sftp.host,
    port: config.sftp.port,
    username: config.sftp.user,
    password: config.sftp.password,
    // Options de connexion
    readyTimeout: 20000, // 20 secondes max pour établir la connexion
    retries: config.security.maxRetries,
    retry_factor: 2, // Backoff exponentiel
    retry_minTimeout: 2000, // Attente minimum entre les retries
  };
}

/**
 * Upload un fichier sur le serveur SFTP
 *
 * Cette fonction :
 * 1. Ouvre une connexion SFTP
 * 2. Crée le dossier distant si nécessaire
 * 3. Upload le contenu du fichier
 * 4. Ferme proprement la connexion
 *
 * @param {string|Buffer} content - Contenu du fichier à uploader
 * @param {string} remoteFileName - Nom du fichier distant
 * @param {string} remoteDir - Dossier distant (optionnel, utilise config par défaut)
 * @returns {Promise<Object>} Résultat de l'upload { success, remotePath }
 *
 * @example
 * await uploadFile('contenu du fichier', 'commande_12345.txt');
 */
async function uploadFile(content, remoteFileName, remoteDir = config.sftp.remoteDir) {
  const sftp = createSftpClient();
  const remotePath = path.posix.join(remoteDir, remoteFileName);

  log.info('Début de l\'upload SFTP', {
    remoteFileName,
    remoteDir,
    remotePath,
    contentLength: content.length,
  });

  try {
    // Connexion au serveur SFTP
    await sftp.connect(getSftpConfig());
    log.debug('Connexion SFTP établie');

    // Vérifier/créer le dossier distant
    const dirExists = await sftp.exists(remoteDir);
    if (!dirExists) {
      log.info('Création du dossier distant', { remoteDir });
      await sftp.mkdir(remoteDir, true); // true = récursif
    }

    // Convertir le contenu en Buffer si c'est une string
    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');

    // Upload du fichier
    await sftp.put(contentBuffer, remotePath);

    log.info('Upload SFTP réussi', {
      remotePath,
      size: contentBuffer.length,
    });

    return {
      success: true,
      remotePath,
      size: contentBuffer.length,
      message: `Fichier uploadé avec succès: ${remotePath}`,
    };
  } catch (error) {
    log.error('Erreur lors de l\'upload SFTP', {
      error: error.message,
      remoteFileName,
      remotePath,
    });

    throw error;
  } finally {
    // Toujours fermer la connexion proprement
    try {
      await sftp.end();
      log.debug('Connexion SFTP fermée');
    } catch (closeError) {
      log.warn('Erreur lors de la fermeture de la connexion SFTP', {
        error: closeError.message,
      });
    }
  }
}

/**
 * Liste les fichiers d'un dossier sur le serveur SFTP
 *
 * @param {string} remoteDir - Dossier distant à lister
 * @returns {Promise<Array>} Liste des fichiers et dossiers
 */
async function listFiles(remoteDir = config.sftp.remoteDir) {
  const sftp = createSftpClient();

  log.info('Liste des fichiers SFTP', { remoteDir });

  try {
    await sftp.connect(getSftpConfig());
    log.debug('Connexion SFTP établie');

    // Vérifier si le dossier existe
    const dirExists = await sftp.exists(remoteDir);
    if (!dirExists) {
      log.warn('Le dossier distant n\'existe pas', { remoteDir });
      return [];
    }

    // Lister les fichiers
    const files = await sftp.list(remoteDir);

    log.info('Fichiers listés avec succès', {
      remoteDir,
      count: files.length,
    });

    // Formater la liste pour plus de lisibilité
    return files.map((file) => ({
      name: file.name,
      type: file.type === 'd' ? 'dossier' : 'fichier',
      size: file.size,
      modifyTime: new Date(file.modifyTime),
      accessTime: new Date(file.accessTime),
    }));
  } catch (error) {
    log.error('Erreur lors de la liste des fichiers SFTP', {
      error: error.message,
      remoteDir,
    });

    throw error;
  } finally {
    try {
      await sftp.end();
    } catch (closeError) {
      log.warn('Erreur lors de la fermeture de la connexion SFTP', {
        error: closeError.message,
      });
    }
  }
}

/**
 * Télécharge un fichier depuis le serveur SFTP
 *
 * @param {string} remoteFileName - Nom du fichier distant
 * @param {string} remoteDir - Dossier distant (optionnel)
 * @returns {Promise<Buffer>} Contenu du fichier
 */
async function downloadFile(remoteFileName, remoteDir = config.sftp.remoteDir) {
  const sftp = createSftpClient();
  const remotePath = path.posix.join(remoteDir, remoteFileName);

  log.info('Téléchargement de fichier SFTP', { remotePath });

  try {
    await sftp.connect(getSftpConfig());
    log.debug('Connexion SFTP établie');

    // Vérifier si le fichier existe
    const fileExists = await sftp.exists(remotePath);
    if (!fileExists) {
      throw new Error(`Le fichier n'existe pas: ${remotePath}`);
    }

    // Télécharger le fichier
    const content = await sftp.get(remotePath);

    log.info('Fichier téléchargé avec succès', {
      remotePath,
      size: content.length,
    });

    return content;
  } catch (error) {
    log.error('Erreur lors du téléchargement SFTP', {
      error: error.message,
      remotePath,
    });

    throw error;
  } finally {
    try {
      await sftp.end();
    } catch (closeError) {
      log.warn('Erreur lors de la fermeture de la connexion SFTP', {
        error: closeError.message,
      });
    }
  }
}

/**
 * Supprime un fichier sur le serveur SFTP
 *
 * @param {string} remoteFileName - Nom du fichier à supprimer
 * @param {string} remoteDir - Dossier distant (optionnel)
 * @returns {Promise<Object>} Résultat de la suppression
 */
async function deleteFile(remoteFileName, remoteDir = config.sftp.remoteDir) {
  const sftp = createSftpClient();
  const remotePath = path.posix.join(remoteDir, remoteFileName);

  log.info('Suppression de fichier SFTP', { remotePath });

  try {
    await sftp.connect(getSftpConfig());
    log.debug('Connexion SFTP établie');

    // Vérifier si le fichier existe
    const fileExists = await sftp.exists(remotePath);
    if (!fileExists) {
      log.warn('Le fichier à supprimer n\'existe pas', { remotePath });
      return {
        success: false,
        message: `Le fichier n'existe pas: ${remotePath}`,
      };
    }

    // Supprimer le fichier
    await sftp.delete(remotePath);

    log.info('Fichier supprimé avec succès', { remotePath });

    return {
      success: true,
      remotePath,
      message: `Fichier supprimé: ${remotePath}`,
    };
  } catch (error) {
    log.error('Erreur lors de la suppression SFTP', {
      error: error.message,
      remotePath,
    });

    throw error;
  } finally {
    try {
      await sftp.end();
    } catch (closeError) {
      log.warn('Erreur lors de la fermeture de la connexion SFTP', {
        error: closeError.message,
      });
    }
  }
}

/**
 * Teste la connexion au serveur SFTP
 *
 * @returns {Promise<Object>} Résultat du test { success, message, ... }
 */
async function testConnection() {
  const sftp = createSftpClient();

  log.info('Test de connexion SFTP', {
    host: config.sftp.host,
    port: config.sftp.port,
    user: config.sftp.user,
  });

  try {
    await sftp.connect(getSftpConfig());
    log.debug('Connexion SFTP établie');

    // Récupérer le répertoire courant
    const cwd = await sftp.cwd();

    // Lister le dossier de destination s'il existe
    let destDirInfo = null;
    try {
      const dirExists = await sftp.exists(config.sftp.remoteDir);
      if (dirExists) {
        const files = await sftp.list(config.sftp.remoteDir);
        destDirInfo = {
          exists: true,
          fileCount: files.length,
        };
      } else {
        destDirInfo = {
          exists: false,
          message: `Le dossier ${config.sftp.remoteDir} n'existe pas`,
        };
      }
    } catch (dirError) {
      destDirInfo = {
        exists: false,
        error: dirError.message,
      };
    }

    log.info('Test de connexion SFTP réussi', {
      cwd,
      destDir: destDirInfo,
    });

    return {
      success: true,
      message: 'Connexion SFTP réussie',
      host: config.sftp.host,
      port: config.sftp.port,
      user: config.sftp.user,
      currentDirectory: cwd,
      destinationDirectory: destDirInfo,
    };
  } catch (error) {
    log.error('Échec du test de connexion SFTP', {
      error: error.message,
      host: config.sftp.host,
    });

    return {
      success: false,
      message: `Erreur de connexion: ${error.message}`,
      host: config.sftp.host,
      port: config.sftp.port,
    };
  } finally {
    try {
      await sftp.end();
    } catch (closeError) {
      // Ignorer les erreurs de fermeture pendant le test
    }
  }
}

/**
 * Crée un dossier sur le serveur SFTP
 *
 * @param {string} remoteDir - Chemin du dossier à créer
 * @returns {Promise<Object>} Résultat de la création
 */
async function createDirectory(remoteDir) {
  const sftp = createSftpClient();

  log.info('Création de dossier SFTP', { remoteDir });

  try {
    await sftp.connect(getSftpConfig());
    log.debug('Connexion SFTP établie');

    // Vérifier si le dossier existe déjà
    const dirExists = await sftp.exists(remoteDir);
    if (dirExists) {
      log.info('Le dossier existe déjà', { remoteDir });
      return {
        success: true,
        message: `Le dossier existe déjà: ${remoteDir}`,
        created: false,
      };
    }

    // Créer le dossier récursivement
    await sftp.mkdir(remoteDir, true);

    log.info('Dossier créé avec succès', { remoteDir });

    return {
      success: true,
      message: `Dossier créé: ${remoteDir}`,
      created: true,
    };
  } catch (error) {
    log.error('Erreur lors de la création du dossier SFTP', {
      error: error.message,
      remoteDir,
    });

    throw error;
  } finally {
    try {
      await sftp.end();
    } catch (closeError) {
      log.warn('Erreur lors de la fermeture de la connexion SFTP', {
        error: closeError.message,
      });
    }
  }
}

module.exports = {
  uploadFile,
  listFiles,
  downloadFile,
  deleteFile,
  testConnection,
  createDirectory,
};
