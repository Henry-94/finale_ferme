const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// Configuration du serveur HTTP minimal pour le WebSocket
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Farm Intelligent Server</h1><p>WebSocket server running on ws://localhost:10000</p>');
});

// Serveur WebSocket sur le port 10000
const wss = new WebSocket.Server({ server });
const PORT = 10000;

// Objets pour gérer les clients
const clients = {
  androids: new Map(), // Map: clientId -> WebSocket
  espCams: [],        // Tableau des sockets ESP32-CAM
  espStandards: []    // Tableau des sockets ESP32-Standard
};

// Files d'attente pour les commandes si les ESPs sont déconnectés
const espCamCommandsQueue = [];
const espStandardCommandsQueue = [];

// File d'attente pour les alertes/images si aucun Android n'est connecté
const pendingAlerts = [];

// --- Fonctions utilitaires ---

/**
 * Envoie un message JSON à un socket spécifique.
 * @param {WebSocket} socket - Le socket destinataire.
 * @param {string} type - Le type de message.
 * @param {object} [data={}] - Les données JSON.
 * @returns {boolean} - true si envoyé, false sinon.
 */
function sendJsonMessage(socket, type, data = {}) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      const message = JSON.stringify({ type, ...data });
      socket.send(message);
      // console.log(`Message envoyé à ${getClientType(socket)} (ID: ${socket.clientId}): ${message.substring(0, 100)}...`);
      return true;
    } catch (e) {
      console.error(`Erreur JSON/envoi pour ${getClientType(socket)} (ID: ${socket.clientId}):`, e.message);
      return false;
    }
  }
  console.log(`Échec envoi message à ${getClientType(socket)} (ID: ${socket.clientId}): socket fermé`);
  return false;
}

/**
 * Obtient le type de client (pour logging).
 * @param {WebSocket} socket - Le socket client.
 * @returns {string} - Le type de client.
 */
function getClientType(socket) {
  if (socket.clientType === 'android') return 'Android';
  if (socket.clientType === 'esp32-cam') return 'ESP-CAM';
  if (socket.clientType === 'esp32-standard') return 'ESP-Standard';
  return 'Unknown';
}

/**
 * Broadcast une alerte/image à tous les Androids.
 * @param {string} message - Le message de l'alerte.
 * @param {Buffer | null} imageData - Les données binaires de l'image.
 */
function broadcastAlertToAndroids(message, imageData = null) {
  if (clients.androids.size > 0) {
    clients.androids.forEach((androidSocket) => {
      if (androidSocket.readyState === WebSocket.OPEN) {
        try {
          // 1. Envoi de l'image binaire (si présente)
          if (imageData) {
            androidSocket.send(imageData); 
          }
          // 2. Envoi du message JSON de l'alerte
          sendJsonMessage(androidSocket, 'alert', { message });
        } catch (error) {
          console.error(`Erreur envoi à Android (ID: ${androidSocket.clientId}):`, error.message);
        }
      }
    });
  } else {
    // Stocker l'alerte pour retry (limite à 100 alertes)
    if (pendingAlerts.length < 100) {
      console.log('Aucun Android connecté. Alerte stockée:', message);
      pendingAlerts.push({ message, imageData, timestamp: Date.now() });
    } else {
      console.warn('File d\'alertes pleine, alerte ignorée:', message);
    }
  }
}

/**
 * Retente l'envoi des alertes/images en attente.
 */
function retryPendingAlerts() {
  if (pendingAlerts.length === 0 || clients.androids.size === 0) return;

  // Supprimer les alertes trop anciennes (ex: > 1 heure)
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 heure
  const validAlerts = pendingAlerts.filter(alert => now - alert.timestamp <= maxAge);
  pendingAlerts.length = 0; // Vider la file
  pendingAlerts.push(...validAlerts); // Restaurer les alertes valides

  if (clients.androids.size > 0) {
    console.log(`Tentative de renvoi de ${validAlerts.length} alerte(s) en attente.`);
    // Utilisation de forEach pour éviter une boucle infinie si broadcast ajoute l'alerte
    // Note: Cette boucle est optimisée pour ne pas re-stocker immédiatement si l'envoi échoue
    validAlerts.forEach(({ message, imageData }) => {
      broadcastAlertToAndroids(message, imageData);
    });
  }
}

/**
 * Envoie le statut des ESPs à tous les Androids.
 * @param {('espCam' | 'espStandard')} espType - Le type d'ESP dont le statut a changé.
 * @param {boolean} connected - Le statut (connecté ou déconnecté).
 */
function broadcastEspStatus(espType, connected) {
  const status = {
    type: 'esp_status',
    [espType]: connected,
    // Envoyer les deux statuts pour la cohérence
    espCam: clients.espCams.length > 0,
    espStandard: clients.espStandards.length > 0
  };
  clients.androids.forEach((androidSocket) => {
    if (androidSocket.readyState === WebSocket.OPEN) {
      sendJsonMessage(androidSocket, status.type, status);
    }
  });
}

/**
 * Distribue une commande d'Android aux ESPs.
 * @param {string} type - Le type de commande.
 * @param {object} params - Les paramètres de la commande.
 * @param {WebSocket} androidSocket - Le socket Android d'origine.
 */
function distributeCommand(type, params, androidSocket) {
  const command = { type, params };
  let sentToCam = false;
  let sentToStd = false;

  // Envoyer à ESP32-CAM
  if (clients.espCams.length > 0) {
    clients.espCams.forEach((espSocket) => {
      if (sendJsonMessage(espSocket, type, params)) {
        sentToCam = true;
      }
    });
  } else {
    // N'ajoutez que si elle n'est pas déjà dans la file pour éviter la duplication excessive
    const isQueued = espCamCommandsQueue.some(cmd => cmd.type === type && JSON.stringify(cmd.params) === JSON.stringify(params));
    if (!isQueued) {
      espCamCommandsQueue.push(command);
    }
  }

  // Envoyer à ESP32-Standard
  if (clients.espStandards.length > 0) {
    clients.espStandards.forEach((espSocket) => {
      if (sendJsonMessage(espSocket, type, params)) {
        sentToStd = true;
      }
    });
  } else {
    const isQueued = espStandardCommandsQueue.some(cmd => cmd.type === type && JSON.stringify(cmd.params) === JSON.stringify(params));
    if (!isQueued) {
      espStandardCommandsQueue.push(command);
    }
  }

  // Réponse à l'Android
  const message = `${type} envoyé. CAM: ${sentToCam ? 'OK' : 'Queue'}, STD: ${sentToStd ? 'OK' : 'Queue'}`;
  sendJsonMessage(androidSocket, 'command_response', { success: true, message });
}

// --- Gestion des connexions WebSocket ---

wss.on('connection', (socket, req) => {
  const clientId = uuidv4();
  socket.clientId = clientId;
  socket.clientType = null; // Type non défini jusqu'à réception de 'register'
  const clientIp = req.socket.remoteAddress;
  console.log(`🔗 Nouveau client connecté depuis ${clientIp} (ID: ${clientId})`);

  // Définir un délai pour l'enregistrement (15 secondes)
  const registrationTimeout = setTimeout(() => {
    if (!socket.clientType && socket.readyState === WebSocket.OPEN) {
      console.log(`Client ${clientId} non enregistré après 15s, fermeture connexion`);
      sendJsonMessage(socket, 'error', { message: 'Enregistrement requis (Timeout)' });
      socket.close(1008, 'Non enregistré');
    }
  }, 15000);

  // Ping périodique
  const pingInterval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        sendJsonMessage(socket, 'ping');
      } catch (e) {
        console.error(`Erreur ping pour client ${clientId}:`, e.message);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  socket.on('message', (message) => {
    // --- GESTION DE L'ENREGISTREMENT ---
    if (!socket.clientType) {
      if (typeof message === 'string') {
        try {
          const data = JSON.parse(message);
          const type = data.type;
          console.log(`Message JSON reçu avant enregistrement (ID: ${clientId}): ${type}`);
          
          if (type === 'register') {
            clearTimeout(registrationTimeout); // Annuler le timeout
            const device = data.device;
            socket.clientType = device;
            
            if (device === 'android') {
              clients.androids.set(clientId, socket);
              console.log('✅ Android connecté');
              sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
              // Envoyer les statuts actuels des ESPs
              sendJsonMessage(socket, 'esp_status', {
                espCam: clients.espCams.length > 0,
                espStandard: clients.espStandards.length > 0
              });
              // Retenter l'envoi des alertes en attente
              retryPendingAlerts();
            } else if (device === 'esp32-cam') {
              clients.espCams.push(socket);
              console.log('✅ ESP32-CAM connecté');
              sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
              broadcastEspStatus('espCam', true);
              // Envoyer les commandes en attente
              while (espCamCommandsQueue.length > 0) {
                const cmd = espCamCommandsQueue.shift();
                sendJsonMessage(socket, cmd.type, cmd.params);
              }
            } else if (device === 'esp32-standard') {
              clients.espStandards.push(socket);
              console.log('✅ ESP32-Standard connecté');
              sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
              broadcastEspStatus('espStandard', true);
              // Envoyer les commandes en attente
              while (espStandardCommandsQueue.length > 0) {
                const cmd = espStandardCommandsQueue.shift();
                sendJsonMessage(socket, cmd.type, cmd.params);
              }
            } else {
              console.warn(`Type d'appareil inconnu: ${device} (ID: ${clientId})`);
              sendJsonMessage(socket, 'error', { message: `Type d'appareil inconnu: ${device}` });
              socket.close(1008, 'Type d\'appareil inconnu');
            }
            return;
          } else {
            console.warn(`Message non-register reçu avant enregistrement (ID: ${clientId}): ${type}. Ignoré.`);
            // Ne pas renvoyer d'erreur ici pour laisser le client se corriger ou attendre le timeout
            return; 
          }
        } catch (error) {
          console.error(`Erreur parsing JSON avant enregistrement (ID: ${clientId}):`, error.message);
          // Ne pas fermer immédiatement, on attend le timeout
          return;
        }
      } else if (message instanceof Buffer) {
        // C'est ici qu'il y a un problème si l'ESP envoie l'image d'abord. On ignore et on log.
        console.warn(`Données binaires reçues AVANT enregistrement (ID: ${clientId}), taille: ${message.length} bytes. Ignoré.`);
        // Ne pas renvoyer d'erreur ni fermer, on attend le timeout
        return;
      }
    }

    // --- GESTION DES MESSAGES POST-ENREGISTREMENT ---
    
    if (typeof message === 'string') {
      // Message JSON
      try {
        const data = JSON.parse(message);
        const type = data.type;
        console.log(`Message JSON reçu de ${getClientType(socket)} (ID: ${clientId}): ${type}`);

        // Commandes depuis Android
        if (socket.clientType === 'android') {
          if (type === 'network_config' || type === 'security_config') {
            const params = data.params || {};
            console.log(`Commande ${type} reçue de Android (ID: ${clientId}):`, params);
            distributeCommand(type, params, socket);
          } else if (type === 'pong') {
            // OK
          } else {
            console.warn(`Type de commande inconnu de Android: ${type} (ID: ${clientId})`);
            sendJsonMessage(socket, 'error', { message: `Type de commande inconnu: ${type}` });
          }
          return;
        }

        // Alertes depuis ESPs
        if (type === 'alert' && (socket.clientType === 'esp32-cam' || socket.clientType === 'esp32-standard')) {
          const msg = data.message || 'Alerte sans message';
          console.log(`Alerte reçue de ${socket.clientType} (ID: ${clientId}): ${msg}`);
          // Allumer la lampe sur l'autre ESP (Action de sécurité)
          const otherEsps = socket.clientType === 'esp32-cam' ? clients.espStandards : clients.espCams;
          const otherQueue = socket.clientType === 'esp32-cam' ? espStandardCommandsQueue : espCamCommandsQueue;
          otherEsps.forEach((otherEsp) => {
            if (otherEsp.readyState === WebSocket.OPEN) {
              sendJsonMessage(otherEsp, 'turn_on_light', { reason: 'alert_detected' });
            } else {
              // Ajouter à la queue uniquement si l'autre ESP est déconnecté
              otherQueue.push({ type: 'turn_on_light', params: { reason: 'alert_detected' } });
            }
          });
          // Forward à Androids (Sans image ici, l'image est envoyée séparément)
          broadcastAlertToAndroids(msg);
        } else if (type === 'pong') {
          // OK
        } else {
          console.warn(`Message non géré de ${socket.clientType} (ID: ${clientId}): ${type}`);
        }
      } catch (error) {
        console.error(`Erreur parsing JSON pour client ${clientId}:`, error.message);
        sendJsonMessage(socket, 'error', { message: 'Message JSON invalide' });
      }
    } else if (message instanceof Buffer) {
      // Image binaire uniquement depuis ESP32-CAM
      if (socket.clientType === 'esp32-cam') {
        console.log(`Image binaire reçue de ESP-CAM (ID: ${clientId}), taille: ${message.length} bytes`);
        // L'alerte est envoyée séparément, ici on ne fait que la transmission de l'image
        // Le message d'alerte sera le message par défaut si l'alerte n'est pas déjà dans la file
        broadcastAlertToAndroids('Photo capturée lors d\'une alerte', message);
      } else {
        console.error(`Image reçue d'un client non ESP-CAM (type: ${socket.clientType}, ID: ${clientId})`);
        sendJsonMessage(socket, 'error', { message: 'Seuls les ESP32-CAM peuvent envoyer des images' });
      }
    }
  });

  socket.on('close', () => {
    clearTimeout(registrationTimeout); // S'assurer que le timeout est annulé
    clearInterval(pingInterval);
    console.log(`${getClientType(socket)} déconnecté (ID: ${clientId})`);
    
    // Supprimer de la liste
    const type = socket.clientType;
    clients.androids.delete(clientId);
    clients.espCams = clients.espCams.filter(s => s !== socket);
    clients.espStandards = clients.espStandards.filter(s => s !== socket);
    
    // Notifier Androids si ESP déconnecté
    if (type === 'esp32-cam') {
      broadcastEspStatus('espCam', clients.espCams.length > 0);
    } else if (type === 'esp32-standard') {
      broadcastEspStatus('espStandard', clients.espStandards.length > 0);
    }
  });

  socket.on('error', (error) => {
    console.error(`Erreur WebSocket pour client ${clientId}:`, error.message);
  });
});

// Retry périodique des alertes en attente
setInterval(retryPendingAlerts, 30000);

// Démarrer le serveur
server.listen(PORT, () => {
  console.log(`🚀 Serveur actif sur port ${PORT}. Écoute HTTP et WS.`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Fermeture du serveur...');
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});
