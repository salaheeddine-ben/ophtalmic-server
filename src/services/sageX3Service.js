/**
 * Service Sage X3 - Client SOAP pour interroger le webservice Sage X3
 *
 * Ce service gère la communication avec le webservice SOAP de Sage X3
 * pour récupérer les informations de stock des produits.
 *
 * Le webservice Sage X3 utilise une structure XML complexe :
 * - Authentification Basic Auth + paramètres SOAP
 * - Données d'entrée/sortie en XML encapsulées dans le message SOAP
 *
 * Support Fixie Socks :
 * - Si FIXIE_SOCKS_HOST est défini, les requêtes passent par le proxy SOCKS5
 * - Cela permet d'avoir une IP statique pour les firewalls
 *
 * @module services/sageX3Service
 */

const soap = require('soap');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');

// Logger dédié à ce module
const log = createModuleLogger('sageX3Service');

/**
 * Crée un agent HTTPS avec le certificat CA de confiance si configuré
 * Nécessaire pour faire confiance au certificat du serveur Sage X3 (auto-signé ou CA interne)
 * @returns {https.Agent|undefined} Agent HTTPS ou undefined
 */
function createHttpsAgentWithCert() {
  const certBase64 = config.sageX3.clientCertBase64;

  if (!certBase64) {
    log.debug('Pas de certificat CA configuré pour Sage X3');
    return undefined;
  }

  try {
    // Décoder le certificat CA depuis Base64
    const caCert = Buffer.from(certBase64, 'base64').toString('utf-8');
    log.info('Certificat CA chargé pour Sage X3 (trust du serveur)');

    const agentOptions = {
      // Le certificat est utilisé comme CA de confiance (pas comme cert client)
      ca: caCert,
      // Vérifier le certificat serveur avec notre CA
      rejectUnauthorized: true,
    };

    return new https.Agent(agentOptions);
  } catch (error) {
    log.error('Erreur lors du chargement du certificat CA', {
      error: error.message,
    });
    return undefined;
  }
}

/**
 * Crée un agent SOCKS5 pour le proxy Fixie si configuré
 * @returns {SocksProxyAgent|undefined} Agent SOCKS5 ou undefined
 */
function createSocksAgent() {
  const fixieSocksHost = process.env.FIXIE_SOCKS_HOST;

  if (!fixieSocksHost) {
    log.debug('Pas de proxy SOCKS5 configuré pour Sage X3');
    return undefined;
  }

  log.info('Configuration du proxy SOCKS5 pour Sage X3', {
    proxy: fixieSocksHost.replace(/:[^:]*@/, ':***@'), // Masquer le mot de passe
  });

  // Format FIXIE_SOCKS_HOST : username:password@host:port
  const proxyUrl = `socks5://${fixieSocksHost}`;
  return new SocksProxyAgent(proxyUrl);
}

// Options pour le parser XML
const xmlParserOptions = {
  ignoreAttributes: false, // Garder les attributs XML
  attributeNamePrefix: '@_', // Préfixe pour les attributs
  textNodeName: '#text', // Nom pour les noeuds texte
};

// Parser et builder XML
const xmlParser = new XMLParser(xmlParserOptions);
const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true, // Formater le XML pour lisibilité
});

// Client SOAP (sera initialisé à la première utilisation)
let soapClient = null;

/**
 * Initialise le client SOAP avec le WSDL de Sage X3
 *
 * Cette fonction crée le client SOAP et configure :
 * - L'authentification Basic Auth
 * - Les options de sécurité (certificats SSL, etc.)
 * - Le proxy SOCKS5 Fixie si configuré
 *
 * @returns {Promise<Object>} Client SOAP initialisé
 * @throws {Error} Si la connexion au WSDL échoue
 */
async function initSoapClient() {
  // Si le client existe déjà, le retourner
  if (soapClient) {
    return soapClient;
  }

  log.info('Initialisation du client SOAP Sage X3', {
    wsdlUrl: config.sageX3.wsdlUrl,
  });

  try {
    // Créer l'agent SOCKS5 si Fixie est configuré
    const socksAgent = createSocksAgent();

    // Créer l'agent HTTPS avec certificat client si configuré
    const httpsAgentWithCert = createHttpsAgentWithCert();

    // Déterminer quel agent utiliser (SOCKS5 a priorité, sinon HTTPS avec cert)
    const agent = socksAgent || httpsAgentWithCert;

    // Options du client SOAP
    const soapOptions = {
      // Options de connexion pour récupérer le WSDL
      wsdl_options: {
        // Authentification Basic Auth pour récupérer le WSDL
        auth: {
          user: config.sageX3.user,
          pass: config.sageX3.password,
        },
        // Timeout de connexion
        timeout: config.security.apiTimeout,
        // Utiliser l'agent (SOCKS5 ou HTTPS avec CA cert)
        agent: agent,
        // Si on a un certificat CA configuré, l'ajouter pour faire confiance au serveur
        ...(config.sageX3.clientCertBase64 && {
          ca: Buffer.from(config.sageX3.clientCertBase64, 'base64').toString('utf-8'),
          rejectUnauthorized: true,
        }),
        // Si pas de certificat CA, accepter en dev mais rejeter en prod
        ...(!config.sageX3.clientCertBase64 && {
          rejectUnauthorized: config.server.isProduction,
        }),
      },
    };

    log.info('Options SOAP configurées', {
      hasProxy: !!socksAgent,
      hasCACertificate: !!config.sageX3.clientCertBase64,
    });

    // Créer le client SOAP à partir du WSDL
    soapClient = await soap.createClientAsync(config.sageX3.wsdlUrl, soapOptions);

    // Configurer l'authentification Basic Auth pour les appels
    soapClient.setSecurity(
      new soap.BasicAuthSecurity(config.sageX3.user, config.sageX3.password)
    );

    // Configurer l'endpoint SOAP (soap-generic au lieu de soap-wsdl)
    // Si endpointUrl est défini, l'utiliser, sinon dériver du WSDL
    const endpointUrl = config.sageX3.endpointUrl || config.sageX3.wsdlUrl.replace('?wsdl', '');
    soapClient.setEndpoint(endpointUrl);
    log.debug('Endpoint SOAP configuré', { endpointUrl });

    // Configurer l'agent pour les appels SOAP (SOCKS5 ou HTTPS avec CA cert)
    soapClient.httpClient.options = soapClient.httpClient.options || {};

    if (agent) {
      soapClient.httpClient.options.agent = agent;
    }

    // Ajouter le certificat CA pour faire confiance au serveur Sage X3
    if (config.sageX3.clientCertBase64) {
      soapClient.httpClient.options.ca = Buffer.from(config.sageX3.clientCertBase64, 'base64').toString('utf-8');
      soapClient.httpClient.options.rejectUnauthorized = true;
    }

    log.info('Client SOAP Sage X3 initialisé avec succès', {
      proxyEnabled: !!socksAgent,
      caCertificateEnabled: !!config.sageX3.clientCertBase64,
    });

    return soapClient;
  } catch (error) {
    log.error('Erreur lors de l\'initialisation du client SOAP', {
      error: error.message,
      wsdlUrl: config.sageX3.wsdlUrl,
    });
    throw error;
  }
}

/**
 * Construit le XML d'entrée pour la requête de stock
 *
 * Structure XML attendue par Sage X3 :
 * <PARAM>
 *   <TAB ID="GRP2">
 *     <LIN>
 *       <FLD NAM="I_CODEDI"></FLD>
 *       <FLD NAM="I_ITMREF"></FLD>
 *       <FLD NAM="I_CODEAN">[EAN]</FLD>
 *       <FLD NAM="I_STOFCY">[SITE]</FLD>
 *       <FLD NAM="I_QTYDMD">1</FLD>
 *     </LIN>
 *   </TAB>
 * </PARAM>
 *
 * @param {string} eanCode - Code EAN du produit
 * @param {string} site - Code du site de stockage
 * @param {number} quantity - Quantité demandée (par défaut 1)
 * @returns {string} XML formaté pour la requête
 */
function buildStockRequestXml(eanCode, site, quantity = 1) {
  const xmlData = {
    PARAM: {
      TAB: {
        '@_ID': 'GRP2',
        LIN: {
          FLD: [
            { '@_NAM': 'I_CODEDI', '#text': '' },
            { '@_NAM': 'I_ITMREF', '#text': '' },
            { '@_NAM': 'I_CODEAN', '#text': eanCode },
            { '@_NAM': 'I_STOFCY', '#text': site },
            { '@_NAM': 'I_QTYDMD', '#text': quantity.toString() },
          ],
        },
      },
    },
  };

  // Construire le XML avec l'en-tête
  const xml = '<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + xmlBuilder.build(xmlData);

  log.debug('XML de requête généré', { xml });

  return xml;
}

/**
 * Parse la réponse XML de Sage X3 pour extraire les données de stock
 *
 * La réponse contient :
 * - O_QTY : Quantité en stock
 * - O_DISPO : Disponibilité (0 ou 1)
 * - O_MESS : Message (ex: "En Stock", "Rupture")
 *
 * @param {string} responseXml - XML de réponse de Sage X3
 * @returns {Object} Données de stock parsées
 */
function parseStockResponseXml(responseXml) {
  try {
    const parsed = xmlParser.parse(responseXml);

    log.debug('Réponse XML parsée', { parsed: JSON.stringify(parsed, null, 2) });

    // Naviguer dans la structure XML pour trouver les champs
    // La structure exacte peut varier, adapter si nécessaire
    let stockData = {
      quantity: 0,
      available: false,
      message: '',
      rawResponse: parsed,
    };

    // Chercher les champs dans la réponse
    // TODO: Adapter cette extraction selon la structure réelle de la réponse
    // La structure dépend du webservice YSSTODIS

    // Tenter d'extraire depuis une structure PARAM/TAB/LIN/FLD
    try {
      const result = parsed.RESULT || parsed.result || parsed;
      const tab = result.TAB || result.tab || result.GRP1 || [];
      const lines = Array.isArray(tab) ? tab : [tab];

      for (const line of lines) {
        const fields = line.LIN?.FLD || line.FLD || [];
        const fieldArray = Array.isArray(fields) ? fields : [fields];

        for (const field of fieldArray) {
          const name = field['@_NAM'] || field['@_NAME'] || field.NAM || '';
          const value = field['#text'] || field.value || field._ || '';

          switch (name) {
            case 'O_QTY':
              stockData.quantity = parseInt(value, 10) || 0;
              break;
            case 'O_DISPO':
              stockData.available = value === '1' || value === 'true';
              break;
            case 'O_MESS':
              stockData.message = value;
              break;
          }
        }
      }
    } catch (extractError) {
      log.warn('Erreur lors de l\'extraction des champs de stock', {
        error: extractError.message,
      });
    }

    return stockData;
  } catch (error) {
    log.error('Erreur lors du parsing de la réponse XML', {
      error: error.message,
      responseXml: responseXml?.substring(0, 500), // Log les premiers 500 caractères
    });
    throw error;
  }
}

/**
 * Récupère le stock d'un produit depuis Sage X3
 *
 * Cette fonction :
 * 1. Initialise le client SOAP si nécessaire
 * 2. Construit le XML de requête
 * 3. Appelle le webservice Sage X3
 * 4. Parse et retourne les données de stock
 *
 * @param {string} eanCode - Code EAN du produit (par défaut: Hydrofeel)
 * @returns {Promise<Object>} Données de stock { quantity, available, message }
 * @throws {Error} Si l'appel SOAP échoue
 *
 * @example
 * const stock = await getProductStock('3661484004792');
 * console.log(`Stock: ${stock.quantity}, Message: ${stock.message}`);
 */
async function getProductStock(eanCode = config.product.hydrofellEan) {
  log.info('Récupération du stock produit', { eanCode });

  try {
    // Initialiser le client SOAP
    const client = await initSoapClient();

    // Construire le XML d'entrée
    const inputXml = buildStockRequestXml(eanCode, config.sageX3.site);

    // Paramètres de l'appel SOAP
    // Structure selon la documentation Sage X3 WebService
    // Note: codeUser et password NE DOIVENT PAS être dans callContext
    // L'authentification se fait uniquement via Basic Auth dans le header HTTP
    const soapParams = {
      callContext: {
        codeLang: config.sageX3.codeLang,
        poolAlias: config.sageX3.poolAlias,
        poolId: '', // Optionnel
        requestConfig: '', // Optionnel
      },
      publicName: config.sageX3.publicName,
      inputXml: inputXml,
    };

    log.debug('Appel SOAP avec les paramètres', {
      publicName: soapParams.publicName,
      poolAlias: soapParams.callContext.poolAlias,
    });

    // Appeler la méthode 'run' du webservice
    // Le nom de la méthode peut varier selon le WSDL (run, execute, etc.)
    const [result] = await client.runAsync(soapParams);

    log.debug('Réponse SOAP brute reçue', {
      resultType: typeof result,
      hasResultXml: !!result?.resultXml,
    });

    // Extraire le XML de résultat
    const resultXml = result?.resultXml || result?.outputXml || result;

    if (!resultXml) {
      throw new Error('Réponse SOAP vide ou invalide');
    }

    // Parser la réponse XML
    const stockData = parseStockResponseXml(resultXml);

    log.info('Stock récupéré avec succès', {
      eanCode,
      quantity: stockData.quantity,
      available: stockData.available,
      message: stockData.message,
    });

    return stockData;
  } catch (error) {
    log.error('Erreur lors de la récupération du stock', {
      eanCode,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Teste la connexion au webservice Sage X3
 *
 * Cette fonction vérifie que :
 * - Le WSDL est accessible
 * - L'authentification fonctionne
 * - Le client SOAP peut être initialisé
 *
 * @returns {Promise<Object>} Résultat du test { success, message, methods }
 */
async function testConnection() {
  log.info('Test de connexion au webservice Sage X3');

  try {
    const client = await initSoapClient();

    // Lister les méthodes disponibles dans le WSDL
    const description = client.describe();
    const services = Object.keys(description);
    const methods = [];

    // Extraire les noms des méthodes de chaque service
    for (const serviceName of services) {
      const service = description[serviceName];
      for (const portName of Object.keys(service)) {
        const port = service[portName];
        methods.push(...Object.keys(port));
      }
    }

    log.info('Connexion Sage X3 réussie', { methods });

    return {
      success: true,
      message: 'Connexion au webservice Sage X3 réussie',
      services,
      methods,
      wsdlUrl: config.sageX3.wsdlUrl,
    };
  } catch (error) {
    log.error('Échec du test de connexion Sage X3', {
      error: error.message,
    });

    return {
      success: false,
      message: `Erreur de connexion: ${error.message}`,
      wsdlUrl: config.sageX3.wsdlUrl,
    };
  }
}

/**
 * Réinitialise le client SOAP
 * Utile pour forcer une nouvelle connexion en cas de problème
 */
function resetClient() {
  soapClient = null;
  log.info('Client SOAP Sage X3 réinitialisé');
}

module.exports = {
  getProductStock,
  testConnection,
  resetClient,
  // Exporter pour les tests
  buildStockRequestXml,
  parseStockResponseXml,
};
