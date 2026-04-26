/**
 * Service Shopify - Client pour l'API Admin Shopify
 *
 * Ce service gère toutes les interactions avec l'API Admin Shopify :
 * - Mise à jour des niveaux d'inventaire
 * - Récupération des informations produits/variants
 * - Gestion des emplacements (locations)
 *
 * L'API Admin Shopify utilise :
 * - Authentification via Access Token (X-Shopify-Access-Token)
 * - Format JSON
 * - Rate limiting (2 requêtes/seconde pour la plupart des endpoints)
 *
 * Support Fixie Socks :
 * - Si FIXIE_SOCKS_HOST est défini, les requêtes passent par le proxy SOCKS5
 * - Cela permet d'avoir une IP statique pour les firewalls
 *
 * @module services/shopifyService
 */

const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');

// Logger dédié à ce module
const log = createModuleLogger('shopifyService');

/**
 * Crée un agent SOCKS5 pour le proxy Fixie si configuré
 * @returns {SocksProxyAgent|undefined} Agent SOCKS5 ou undefined
 */
function createSocksAgent() {
  const fixieSocksHost = process.env.FIXIE_SOCKS_HOST;

  if (!fixieSocksHost) {
    log.debug('Pas de proxy SOCKS5 configuré pour Shopify');
    return undefined;
  }

  log.info('Configuration du proxy SOCKS5 pour Shopify', {
    proxy: fixieSocksHost.replace(/:[^:]*@/, ':***@'), // Masquer le mot de passe
  });

  // Format FIXIE_SOCKS_HOST : username:password@host:port
  // On doit le convertir en URL socks5://
  const proxyUrl = `socks5://${fixieSocksHost}`;
  return new SocksProxyAgent(proxyUrl);
}

/**
 * Crée une instance Axios configurée pour l'API Shopify
 * Avec gestion des headers d'authentification et du rate limiting
 * Utilise le proxy SOCKS5 Fixie si configuré
 */
function createShopifyClient() {
  // Créer l'agent SOCKS5 si Fixie est configuré
  const socksAgent = createSocksAgent();

  const client = axios.create({
    baseURL: `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.accessToken,
    },
    timeout: config.security.apiTimeout,
    // Utiliser l'agent SOCKS5 pour HTTP et HTTPS si disponible
    httpAgent: socksAgent,
    httpsAgent: socksAgent,
  });

  // Intercepteur pour logger les requêtes
  client.interceptors.request.use(
    (requestConfig) => {
      log.debug('Requête Shopify', {
        method: requestConfig.method.toUpperCase(),
        url: requestConfig.url,
      });
      return requestConfig;
    },
    (error) => {
      log.error('Erreur de requête Shopify', { error: error.message });
      return Promise.reject(error);
    }
  );

  // Intercepteur pour gérer les réponses et le rate limiting
  client.interceptors.response.use(
    (response) => {
      // Logger les informations de rate limiting si disponibles
      const remaining = response.headers['x-shopify-shop-api-call-limit'];
      if (remaining) {
        log.debug('Rate limit Shopify', { limit: remaining });
      }
      return response;
    },
    async (error) => {
      // Gérer le rate limiting (HTTP 429)
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || 2;
        log.warn('Rate limit atteint, pause avant retry', { retryAfter });

        // Attendre et réessayer
        await sleep(retryAfter * 1000);
        return client.request(error.config);
      }

      log.error('Erreur de réponse Shopify', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });

      return Promise.reject(error);
    }
  );

  return client;
}

/**
 * Fonction utilitaire pour pause
 * @param {number} ms - Durée en millisecondes
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Instance du client Shopify
const shopifyClient = createShopifyClient();

/**
 * Met à jour le niveau d'inventaire d'un produit sur Shopify
 *
 * Cette fonction utilise l'endpoint inventory_levels/set pour
 * définir le niveau de stock absolu (pas un ajustement relatif).
 *
 * @param {number} quantity - Nouvelle quantité en stock
 * @param {string} inventoryItemId - ID de l'item d'inventaire (optionnel, utilise config par défaut)
 * @param {string} locationId - ID de l'emplacement (optionnel, utilise config par défaut)
 * @returns {Promise<Object>} Résultat de la mise à jour
 *
 * @example
 * await updateInventoryLevel(100);
 * // Met à jour le stock du produit Hydrofeel à 100 unités
 */
async function updateInventoryLevel(
  quantity,
  inventoryItemId = config.shopify.inventoryItemId,
  locationId = config.shopify.locationId
) {
  log.info('Mise à jour du niveau d\'inventaire Shopify', {
    quantity,
    inventoryItemId,
    locationId,
  });

  // Vérifier que les IDs sont configurés
  if (!inventoryItemId || !locationId) {
    const error = new Error(
      'SHOPIFY_INVENTORY_ITEM_ID et SHOPIFY_LOCATION_ID doivent être configurés'
    );
    log.error('Configuration Shopify incomplète', { error: error.message });
    throw error;
  }

  try {
    // Appel API pour définir le niveau d'inventaire
    const response = await shopifyClient.post('/inventory_levels/set.json', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: quantity,
    });

    log.info('Niveau d\'inventaire mis à jour avec succès', {
      inventoryItemId,
      locationId,
      newQuantity: quantity,
      response: response.data,
    });

    return {
      success: true,
      inventoryLevel: response.data.inventory_level,
    };
  } catch (error) {
    log.error('Erreur lors de la mise à jour de l\'inventaire', {
      error: error.message,
      response: error.response?.data,
    });
    throw error;
  }
}

/**
 * Récupère les informations d'un produit par son ID
 *
 * @param {string} productId - ID du produit Shopify
 * @returns {Promise<Object>} Données du produit
 */
async function getProduct(productId) {
  log.info('Récupération du produit Shopify', { productId });

  try {
    const response = await shopifyClient.get(`/products/${productId}.json`);

    log.debug('Produit récupéré', {
      productId,
      title: response.data.product?.title,
    });

    return response.data.product;
  } catch (error) {
    log.error('Erreur lors de la récupération du produit', {
      productId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère les variants d'un produit
 * Utile pour trouver l'inventory_item_id à partir d'un SKU ou EAN
 *
 * @param {string} productId - ID du produit Shopify
 * @returns {Promise<Array>} Liste des variants
 */
async function getProductVariants(productId) {
  log.info('Récupération des variants du produit', { productId });

  try {
    const response = await shopifyClient.get(`/products/${productId}/variants.json`);

    log.debug('Variants récupérés', {
      productId,
      count: response.data.variants?.length,
    });

    return response.data.variants;
  } catch (error) {
    log.error('Erreur lors de la récupération des variants', {
      productId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère la liste des emplacements (locations) du shop
 * Nécessaire pour connaître le location_id à utiliser
 *
 * @returns {Promise<Array>} Liste des emplacements
 */
async function getLocations() {
  log.info('Récupération des emplacements Shopify');

  try {
    const response = await shopifyClient.get('/locations.json');

    log.debug('Emplacements récupérés', {
      count: response.data.locations?.length,
    });

    return response.data.locations;
  } catch (error) {
    log.error('Erreur lors de la récupération des emplacements', {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère le niveau d'inventaire actuel d'un item
 *
 * @param {string} inventoryItemId - ID de l'item d'inventaire
 * @param {string} locationId - ID de l'emplacement
 * @returns {Promise<Object>} Niveau d'inventaire { available, ... }
 */
async function getInventoryLevel(
  inventoryItemId = config.shopify.inventoryItemId,
  locationId = config.shopify.locationId
) {
  log.info('Récupération du niveau d\'inventaire', {
    inventoryItemId,
    locationId,
  });

  try {
    const response = await shopifyClient.get('/inventory_levels.json', {
      params: {
        inventory_item_ids: inventoryItemId,
        location_ids: locationId,
      },
    });

    const level = response.data.inventory_levels?.[0];

    log.debug('Niveau d\'inventaire récupéré', {
      inventoryItemId,
      available: level?.available,
    });

    return level;
  } catch (error) {
    log.error('Erreur lors de la récupération du niveau d\'inventaire', {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Recherche un produit par son SKU ou code-barres (EAN)
 *
 * @param {string} sku - SKU ou code-barres du produit
 * @returns {Promise<Object|null>} Produit trouvé ou null
 */
async function findProductBySku(sku) {
  log.info('Recherche de produit par SKU', { sku });

  try {
    // L'API Shopify ne permet pas de rechercher directement par SKU
    // On doit récupérer tous les produits et filtrer
    // Pour les grands catalogues, utiliser la GraphQL API serait plus efficace
    const response = await shopifyClient.get('/products.json', {
      params: {
        limit: 250,
        fields: 'id,title,variants',
      },
    });

    // Chercher le produit avec le variant correspondant
    for (const product of response.data.products) {
      for (const variant of product.variants) {
        if (variant.sku === sku || variant.barcode === sku) {
          log.info('Produit trouvé par SKU', {
            sku,
            productId: product.id,
            variantId: variant.id,
            inventoryItemId: variant.inventory_item_id,
          });

          return {
            product,
            variant,
            inventoryItemId: variant.inventory_item_id,
          };
        }
      }
    }

    log.warn('Aucun produit trouvé pour ce SKU', { sku });
    return null;
  } catch (error) {
    log.error('Erreur lors de la recherche par SKU', {
      sku,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Teste la connexion à l'API Shopify
 *
 * @returns {Promise<Object>} Résultat du test { success, shop, message }
 */
async function testConnection() {
  log.info('Test de connexion à l\'API Shopify');

  try {
    const response = await shopifyClient.get('/shop.json');
    const shop = response.data.shop;

    log.info('Connexion Shopify réussie', {
      shopName: shop.name,
      domain: shop.domain,
    });

    return {
      success: true,
      message: 'Connexion à Shopify réussie',
      shop: {
        name: shop.name,
        domain: shop.domain,
        email: shop.email,
        currency: shop.currency,
        timezone: shop.iana_timezone,
      },
    };
  } catch (error) {
    log.error('Échec du test de connexion Shopify', {
      error: error.message,
      status: error.response?.status,
    });

    return {
      success: false,
      message: `Erreur de connexion: ${error.message}`,
      error: error.response?.data,
    };
  }
}

/**
 * Récupère les informations de configuration nécessaires
 * Utile pour aider l'utilisateur à configurer les IDs
 *
 * @returns {Promise<Object>} Informations de configuration
 */
async function getConfigurationInfo() {
  log.info('Récupération des informations de configuration Shopify');

  try {
    const [locations, shopResponse] = await Promise.all([
      getLocations(),
      shopifyClient.get('/shop.json'),
    ]);

    return {
      success: true,
      shop: shopResponse.data.shop.name,
      locations: locations.map((loc) => ({
        id: loc.id,
        name: loc.name,
        active: loc.active,
      })),
      instructions: [
        '1. Notez le location_id de votre emplacement principal',
        '2. Pour trouver l\'inventory_item_id, utilisez findProductBySku(ean)',
        '3. Configurez SHOPIFY_LOCATION_ID et SHOPIFY_INVENTORY_ITEM_ID dans .env',
      ],
    };
  } catch (error) {
    log.error('Erreur lors de la récupération des infos de configuration', {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Recherche une commande par son nom (référence)
 * Le nom est généralement au format "#1234" ou "SH1-1234"
 *
 * @param {string} orderName - Nom/référence de la commande
 * @returns {Promise<Object|null>} Commande trouvée ou null
 */
async function findOrderByName(orderName) {
  log.info('Recherche de commande par nom', { orderName });

  try {
    // Nettoyer le nom de la commande (enlever le # si présent)
    const cleanName = orderName.replace(/^#/, '');

    // Rechercher la commande par son nom
    const response = await shopifyClient.get('/orders.json', {
      params: {
        name: cleanName,
        status: 'any',
        limit: 10,
      },
    });

    // Chercher la correspondance exacte
    const orders = response.data.orders || [];
    const order = orders.find(
      (o) =>
        o.name === orderName ||
        o.name === `#${cleanName}` ||
        o.name === cleanName ||
        o.order_number?.toString() === cleanName
    );

    if (order) {
      log.info('Commande trouvée', {
        orderName,
        orderId: order.id,
        fulfillmentStatus: order.fulfillment_status,
      });
      return order;
    }

    log.warn('Commande non trouvée', { orderName });
    return null;
  } catch (error) {
    log.error('Erreur lors de la recherche de commande', {
      orderName,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère les fulfillment orders d'une commande
 * Nécessaire pour créer un fulfillment avec la nouvelle API Shopify
 *
 * @param {string} orderId - ID de la commande Shopify
 * @returns {Promise<Array>} Liste des fulfillment orders
 */
async function getFulfillmentOrders(orderId) {
  log.info('Récupération des fulfillment orders', { orderId });

  try {
    const response = await shopifyClient.get(`/orders/${orderId}/fulfillment_orders.json`);

    return response.data.fulfillment_orders || [];
  } catch (error) {
    log.error('Erreur lors de la récupération des fulfillment orders', {
      orderId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Marque une commande comme expédiée (fulfilled) sur Shopify
 *
 * @param {string} orderRef - Référence de la commande (nom comme SH1-1234)
 * @param {Object} options - Options de fulfillment
 * @param {string} options.trackingNumber - Numéro de suivi (optionnel)
 * @param {string} options.trackingCompany - Transporteur (optionnel)
 * @param {boolean} options.notifyCustomer - Notifier le client par email (défaut: true)
 * @returns {Promise<Object>} Résultat du fulfillment
 */
async function fulfillOrder(orderRef, options = {}) {
  log.info('Fulfillment de la commande', { orderRef, options });

  try {
    // 1. Trouver la commande par son nom
    const order = await findOrderByName(orderRef);

    if (!order) {
      return {
        success: false,
        error: `Commande non trouvée: ${orderRef}`,
      };
    }

    // Vérifier si déjà fulfilled
    if (order.fulfillment_status === 'fulfilled') {
      log.info('Commande déjà fulfilled', { orderRef, orderId: order.id });
      return {
        success: true,
        message: 'Commande déjà marquée comme expédiée',
        alreadyFulfilled: true,
        orderId: order.id,
      };
    }

    // 2. Récupérer les fulfillment orders
    const fulfillmentOrders = await getFulfillmentOrders(order.id);

    if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
      return {
        success: false,
        error: 'Aucun fulfillment order trouvé pour cette commande',
        orderId: order.id,
      };
    }

    // 3. Créer le fulfillment pour chaque fulfillment order qui n'est pas déjà fulfilled
    const results = [];

    for (const fo of fulfillmentOrders) {
      if (fo.status === 'closed' || fo.status === 'cancelled') {
        continue;
      }

      // Préparer les line items à fulfiller
      const lineItemsByFulfillmentOrder = {
        fulfillment_order_id: fo.id,
      };

      // Créer le fulfillment
      const fulfillmentPayload = {
        fulfillment: {
          line_items_by_fulfillment_order: [lineItemsByFulfillmentOrder],
          notify_customer: options.notifyCustomer !== false,
        },
      };

      // Ajouter les informations de tracking si fournies
      if (options.trackingNumber) {
        fulfillmentPayload.fulfillment.tracking_info = {
          number: options.trackingNumber,
          company: options.trackingCompany || '',
        };
      }

      try {
        const response = await shopifyClient.post('/fulfillments.json', fulfillmentPayload);

        results.push({
          fulfillmentOrderId: fo.id,
          fulfillmentId: response.data.fulfillment?.id,
          status: 'success',
        });

        log.info('Fulfillment créé', {
          orderRef,
          fulfillmentOrderId: fo.id,
          fulfillmentId: response.data.fulfillment?.id,
        });
      } catch (fulfillError) {
        log.error('Erreur lors de la création du fulfillment', {
          orderRef,
          fulfillmentOrderId: fo.id,
          error: fulfillError.message,
          response: fulfillError.response?.data,
        });

        results.push({
          fulfillmentOrderId: fo.id,
          status: 'error',
          error: fulfillError.message,
        });
      }
    }

    const allSuccess = results.every((r) => r.status === 'success');

    return {
      success: allSuccess,
      orderId: order.id,
      orderRef,
      fulfillments: results,
      message: allSuccess
        ? 'Commande marquée comme expédiée'
        : 'Certains fulfillments ont échoué',
    };
  } catch (error) {
    log.error('Erreur lors du fulfillment de la commande', {
      orderRef,
      error: error.message,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Récupère une commande par son ID
 *
 * @param {string} orderId - ID de la commande Shopify
 * @returns {Promise<Object>} Données de la commande
 */
async function getOrder(orderId) {
  log.info('Récupération de la commande', { orderId });

  try {
    const response = await shopifyClient.get(`/orders/${orderId}.json`);

    return response.data.order;
  } catch (error) {
    log.error('Erreur lors de la récupération de la commande', {
      orderId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Ajoute ou met à jour une note sur une commande Shopify
 *
 * La note sera AJOUTÉE à la note existante (pas de remplacement)
 * pour conserver l'historique des mises à jour.
 *
 * @param {string} orderRef - Référence de la commande (nom comme SH1-1234)
 * @param {string} noteContent - Contenu de la note à ajouter
 * @param {Object} options - Options
 * @param {boolean} options.append - Ajouter à la note existante (défaut: true)
 * @returns {Promise<Object>} Résultat de la mise à jour
 */
async function addOrderNote(orderRef, noteContent, options = {}) {
  log.info('Ajout de note sur la commande', { orderRef });

  try {
    // 1. Trouver la commande par son nom
    const order = await findOrderByName(orderRef);

    if (!order) {
      return {
        success: false,
        error: `Commande non trouvée: ${orderRef}`,
      };
    }

    // 2. Construire la nouvelle note
    let newNote;

    if (options.append !== false && order.note) {
      // Ajouter à la note existante
      newNote = `${order.note}\n\n${noteContent}`;
    } else {
      // Remplacer la note
      newNote = noteContent;
    }

    // 3. Mettre à jour la commande
    const response = await shopifyClient.put(`/orders/${order.id}.json`, {
      order: {
        id: order.id,
        note: newNote,
      },
    });

    log.info('Note ajoutée avec succès', {
      orderRef,
      orderId: order.id,
      noteLength: newNote.length,
    });

    return {
      success: true,
      orderId: order.id,
      orderRef,
      noteAdded: true,
      message: 'Note ajoutée sur la commande',
    };
  } catch (error) {
    log.error('Erreur lors de l\'ajout de la note', {
      orderRef,
      error: error.message,
      response: error.response?.data,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Ajoute des tags sur une commande Shopify
 *
 * @param {string} orderRef - Référence de la commande (nom comme SH1-1234)
 * @param {string[]} tags - Tags à ajouter
 * @returns {Promise<Object>} Résultat de la mise à jour
 */
async function addOrderTags(orderRef, tags) {
  log.info('Ajout de tags sur la commande', { orderRef, tags });

  try {
    // 1. Trouver la commande par son nom
    const order = await findOrderByName(orderRef);

    if (!order) {
      return {
        success: false,
        error: `Commande non trouvée: ${orderRef}`,
      };
    }

    // 2. Fusionner les tags existants avec les nouveaux
    const existingTags = order.tags ? order.tags.split(', ') : [];
    const allTags = [...new Set([...existingTags, ...tags])];
    const tagsString = allTags.join(', ');

    // 3. Mettre à jour la commande
    const response = await shopifyClient.put(`/orders/${order.id}.json`, {
      order: {
        id: order.id,
        tags: tagsString,
      },
    });

    log.info('Tags ajoutés avec succès', {
      orderRef,
      orderId: order.id,
      tags: allTags,
    });

    return {
      success: true,
      orderId: order.id,
      orderRef,
      tags: allTags,
      message: 'Tags ajoutés sur la commande',
    };
  } catch (error) {
    log.error('Erreur lors de l\'ajout des tags', {
      orderRef,
      error: error.message,
      response: error.response?.data,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================
// API GraphQL pour Shopify Payments (Payouts)
// ============================================

/**
 * Crée un client pour l'API GraphQL Shopify
 * Nécessaire pour accéder à externalTraceId (référence bancaire)
 */
function createGraphQLClient() {
  const socksAgent = createSocksAgent();

  return axios.create({
    baseURL: `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.accessToken,
    },
    timeout: config.security.apiTimeout,
    httpAgent: socksAgent,
    httpsAgent: socksAgent,
  });
}

const graphqlClient = createGraphQLClient();

/**
 * Exécute une requête GraphQL sur l'API Shopify
 *
 * @param {string} query - Requête GraphQL
 * @param {Object} variables - Variables de la requête
 * @returns {Promise<Object>} Réponse de l'API
 */
async function executeGraphQL(query, variables = {}) {
  log.debug('Requête GraphQL Shopify', { variables });

  try {
    const response = await graphqlClient.post('/graphql.json', {
      query,
      variables,
    });

    if (response.data.errors) {
      log.error('Erreurs GraphQL', { errors: response.data.errors });
      throw new Error(response.data.errors[0]?.message || 'Erreur GraphQL');
    }

    return response.data.data;
  } catch (error) {
    log.error('Erreur lors de la requête GraphQL', {
      error: error.message,
      response: error.response?.data,
    });
    throw error;
  }
}

/**
 * Récupère les payouts (virements bancaires) via GraphQL
 * Inclut externalTraceId (référence bancaire) non disponible en REST
 *
 * @param {Object} options - Options de filtrage
 * @param {number} options.first - Nombre de payouts à récupérer (défaut: 10)
 * @param {string} options.status - Filtrer par statut (SCHEDULED, IN_TRANSIT, PAID, FAILED, CANCELLED)
 * @returns {Promise<Array>} Liste des payouts
 */
async function getPayouts(options = {}) {
  const { first = 10, status = null } = options;

  log.info('Récupération des payouts via GraphQL', { first, status });

  const query = `
    query getPayouts($first: Int!) {
      shopifyPaymentsAccount {
        payouts(first: $first, reverse: true) {
          edges {
            node {
              id
              legacyResourceId
              issuedAt
              net {
                amount
                currencyCode
              }
              gross {
                amount
                currencyCode
              }
              fee {
                amount
                currencyCode
              }
              status
              summary {
                adjustmentsGross {
                  amount
                }
                adjustmentsFee {
                  amount
                }
                chargesGross {
                  amount
                }
                chargesFee {
                  amount
                }
                refundsGross {
                  amount
                }
                refundsFee {
                  amount
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await executeGraphQL(query, { first });

  if (!data?.shopifyPaymentsAccount?.payouts?.edges) {
    return [];
  }

  // Transformer les données pour un format plus simple
  const payouts = data.shopifyPaymentsAccount.payouts.edges.map((edge) => {
    const node = edge.node;
    return {
      id: node.id,
      legacyId: node.legacyResourceId,
      issuedAt: node.issuedAt,
      status: node.status,
      net: parseFloat(node.net?.amount) || 0,
      gross: parseFloat(node.gross?.amount) || 0,
      fee: parseFloat(node.fee?.amount) || 0,
      currency: node.net?.currencyCode || 'EUR',
      summary: node.summary,
    };
  });

  log.info('Payouts récupérés', { count: payouts.length });

  return payouts;
}

/**
 * Récupère un payout spécifique par son ID legacy (REST)
 *
 * @param {string} payoutId - ID du payout (format legacy/REST)
 * @returns {Promise<Object>} Détails du payout
 */
async function getPayoutById(payoutId) {
  log.info('Récupération du payout', { payoutId });

  try {
    // 1. Récupérer via REST pour les infos de base
    const response = await shopifyClient.get(`/shopify_payments/payouts/${payoutId}.json`);
    const payout = response.data.payout;

    // 2. Récupérer la référence bancaire via GraphQL
    try {
      const bankReference = await getPayoutBankReference(payoutId);
      if (bankReference) {
        payout.bank_reference = bankReference;
      }
    } catch (graphqlError) {
      log.warn('Impossible de récupérer la référence bancaire via GraphQL', {
        payoutId,
        error: graphqlError.message,
      });
    }

    return payout;
  } catch (error) {
    log.error('Erreur lors de la récupération du payout', {
      payoutId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère la référence bancaire d'un payout via GraphQL
 * (externalTraceId n'est disponible qu'en GraphQL)
 *
 * @param {string} payoutId - ID du payout (format legacy/REST)
 * @returns {Promise<string|null>} Référence bancaire ou null
 */
async function getPayoutBankReference(payoutId) {
  log.debug('Récupération de la référence bancaire via GraphQL', { payoutId });

  // Requête GraphQL avec externalTraceId (référence bancaire réelle)
  const query = `
    query getPayoutBankRef($first: Int!) {
      shopifyPaymentsAccount {
        payouts(first: $first, reverse: true) {
          edges {
            node {
              legacyResourceId
              externalTraceId
            }
          }
        }
      }
    }
  `;

  try {
    const data = await executeGraphQL(query, { first: 50 });

    if (!data?.shopifyPaymentsAccount?.payouts?.edges) {
      return null;
    }

    // Chercher le payout par son legacyResourceId
    for (const edge of data.shopifyPaymentsAccount.payouts.edges) {
      if (edge.node.legacyResourceId === String(payoutId)) {
        // externalTraceId est la vraie référence bancaire (ex: YYW1049573178526)
        return edge.node.externalTraceId || null;
      }
    }

    return null;
  } catch (error) {
    log.warn('Erreur GraphQL pour référence bancaire', { error: error.message });
    return null;
  }
}

/**
 * Récupère une commande par son ID et retourne son nom (ex: SH1-1020)
 *
 * @param {string} orderId - ID de la commande Shopify
 * @returns {Promise<string>} Nom de la commande ou l'ID si erreur
 */
async function getOrderNameById(orderId) {
  log.debug('Récupération du nom de commande', { orderId });

  try {
    const response = await shopifyClient.get(`/orders/${orderId}.json`, {
      params: {
        fields: 'id,name,order_number',
      },
    });

    return response.data.order?.name || `#${orderId}`;
  } catch (error) {
    log.warn('Impossible de récupérer le nom de commande', {
      orderId,
      error: error.message,
    });
    return `#${orderId}`;
  }
}

/**
 * Récupère les transactions d'un payout spécifique
 *
 * @param {string} payoutId - ID du payout
 * @returns {Promise<Array>} Liste des transactions du payout
 */
async function getPayoutTransactions(payoutId) {
  log.info('Récupération des transactions du payout', { payoutId });

  try {
    const response = await shopifyClient.get('/shopify_payments/balance/transactions.json', {
      params: {
        payout_id: payoutId,
        limit: 250,
      },
    });

    const transactions = response.data.transactions || [];

    log.info('Transactions récupérées', {
      payoutId,
      count: transactions.length,
    });

    return transactions;
  } catch (error) {
    log.error('Erreur lors de la récupération des transactions', {
      payoutId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère tous les payouts avec leurs transactions
 * Combine les données REST et GraphQL pour avoir toutes les infos
 *
 * @param {Object} options - Options
 * @param {number} options.limit - Nombre de payouts (défaut: 10)
 * @param {string} options.status - Filtrer par statut
 * @returns {Promise<Array>} Payouts avec leurs transactions
 */
async function getPayoutsWithTransactions(options = {}) {
  const { limit = 10 } = options;

  log.info('Récupération des payouts avec transactions', { limit });

  // 1. Récupérer les payouts via REST (plus complet pour les détails)
  const response = await shopifyClient.get('/shopify_payments/payouts.json', {
    params: { limit },
  });

  const payouts = response.data.payouts || [];

  // 2. Pour chaque payout, récupérer les transactions
  const payoutsWithTransactions = [];

  for (const payout of payouts) {
    try {
      const transactions = await getPayoutTransactions(payout.id);

      payoutsWithTransactions.push({
        ...payout,
        transactions,
      });
    } catch (error) {
      log.warn('Impossible de récupérer les transactions du payout', {
        payoutId: payout.id,
        error: error.message,
      });

      payoutsWithTransactions.push({
        ...payout,
        transactions: [],
        transactionsError: error.message,
      });
    }
  }

  return payoutsWithTransactions;
}

/**
 * Récupère les payouts avec statut "paid" (virés sur le compte)
 *
 * @param {number} limit - Nombre de payouts à récupérer
 * @returns {Promise<Array>} Payouts payés
 */
async function getPaidPayouts(limit = 20) {
  log.info('Récupération des payouts payés', { limit });

  try {
    const response = await shopifyClient.get('/shopify_payments/payouts.json', {
      params: {
        limit,
        status: 'paid',
      },
    });

    return response.data.payouts || [];
  } catch (error) {
    log.error('Erreur lors de la récupération des payouts payés', {
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  updateInventoryLevel,
  getProduct,
  getProductVariants,
  getLocations,
  getInventoryLevel,
  findProductBySku,
  testConnection,
  getConfigurationInfo,
  findOrderByName,
  getFulfillmentOrders,
  fulfillOrder,
  getOrder,
  addOrderNote,
  addOrderTags,
  // Shopify Payments / Payouts
  executeGraphQL,
  getPayouts,
  getPayoutById,
  getPayoutBankReference,
  getPayoutTransactions,
  getPayoutsWithTransactions,
  getPaidPayouts,
  getOrderNameById,
};
