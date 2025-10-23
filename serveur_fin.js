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
  espCams: [],        // Tableau des sockets ESP32-CAM
  espStandards: []    // Tableau des sockets ESP32-Standard
};

// Files d'attente pour les commandes si les ESPs sont déconnectés
const espCamCommandsQueue = [];
const espStandardCommandsQueue = [];

// File d'attente pour les alertes/images si aucun Android n'est connecté
const pendingAlerts = [];

// Fonction pour envoyer un message JSON à un client spécifique
function sendJsonMessage(socket, type, data = {}) {
  if (socket.readyState === WebSocket.OPEN) {
    const message = JSON.stringify({ type, ...data });
    socket.send(message);
    console.log(`Message envoyé à ${getClientType(socket)} (ID: ${socket.clientId}): ${message}`);
    return true;
  }
  console.log(`Échec envoi message à ${getClientType(socket)} (ID: ${socket.clientId}): socket fermé`);
  return false;
}

// Fonction pour obtenir le type de client (pour logging)
function getClientType(socket) {
  if (socket.clientType === 'android') return 'Android';
  if (socket.clientType === 'esp32-cam') return 'ESP-CAM';
  if (socket.clientType === 'esp32-standard') return 'ESP-Standard';
  return 'Unknown';
}

// Fonction pour broadcaster une alerte/image à tous les Androids
function broadcastAlertToAndroids(message, imageData = null) {
  if (clients.androids.size > 0) {
    clients.androids.forEach((androidSocket) => {
      if (androidSocket.readyState === WebSocket.OPEN) {
        try {
          if (imageData) {
            androidSocket.send(imageData); // Envoi binaire
            sendJsonMessage(androidSocket, 'alert', { message });
          } else {
            sendJsonMessage(androidSocket, 'alert', { message });
          }
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

// Fonction pour retenter l'envoi des alertes/images
function retryPendingAlerts() {
  if (pendingAlerts.length === 0 || clients.androids.size === 0) return;

  // Supprimer les alertes trop anciennes (ex: > 1 heure)
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 heure
  const validAlerts = pendingAlerts.filter(alert => now - alert.timestamp <= maxAge);
  pendingAlerts.length = 0; // Vider la file
  pendingAlerts.push(...validAlerts); // Restaurer les alertes valides

  validAlerts.forEach(({ message, imageData }) => {
    broadcastAlertToAndroids(message, imageData);
  });
}

// Fonction pour envoyer le statut des ESPs à tous les Androids
function broadcastEspStatus(espType, connected) {
  const status = {
    type: 'esp_status',
    [espType]: connected
  };
  clients.androids.forEach((androidSocket) => {
    if (androidSocket.readyState === WebSocket.OPEN) {
      sendJsonMessage(androidSocket, status.type, status);
    }
  });
}

// Fonction pour distribuer une commande aux ESPs
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
    espCamCommandsQueue.push(command);
  }

  // Envoyer à ESP32-Standard
  if (clients.espStandards.length > 0) {
    clients.espStandards.forEach((espSocket) => {
      if (sendJsonMessage(espSocket, type, params)) {
        sentToStd = true;
      }
    });
  } else {
    espStandardCommandsQueue.push(command);
  }

  // Réponse à l'Android
  const message = `${type} envoyé. CAM: ${sentToCam ? 'OK' : 'Queue'}, STD: ${sentToStd ? 'OK' : 'Queue'}`;
  sendJsonMessage(androidSocket, 'command_response', { success: true, message });
}

// Gestion des connexions WebSocket
wss.on('connection', (socket, req) => {
  const clientId = uuidv4();
  socket.clientId = clientId;
  socket.clientType = null; // Type non défini jusqu'à réception de 'register'
  const clientIp = req.socket.remoteAddress;
  console.log(`🔗 Nouveau client connecté depuis ${clientIp} (ID: ${clientId})`);

  // Définir un délai pour l'enregistrement
  const registrationTimeout = setTimeout(() => {
    if (!socket.clientType && socket.readyState === WebSocket.OPEN) {
      console.log(`Client ${clientId} non enregistré après 15s, fermeture connexion`);
      sendJsonMessage(socket, 'error', { message: 'Enregistrement requis' });
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
    // Vérifier si le client est enregistré
    if (!socket.clientType) {
      if (typeof message === 'string') {
        try {
          const data = JSON.parse(message);
          const type = data.type;
          console.log(`Message JSON reçu avant enregistrement (ID: ${clientId}): ${type}`);
          
          // Traiter uniquement le message register
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
            console.warn(`Message non-register reçu avant enregistrement (ID: ${clientId}): ${type}`);
            sendJsonMessage(socket, 'error', { message: 'Enregistrement requis avant autres messages' });
            return;
          }
        } catch (error) {
          console.error(`Erreur parsing JSON avant enregistrement (ID: ${clientId}):`, error.message);
          sendJsonMessage(socket, 'error', { message: 'Message JSON invalide' });
          return;
        }
      } else if (message instanceof Buffer) {
        console.warn(`Données binaires reçues avant enregistrement (ID: ${clientId}), taille: ${message.length} bytes`);
        sendJsonMessage(socket, 'error', { message: 'Enregistrement requis avant envoi de données binaires' });
        return;
      }
    }

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
            console.log(`Pong reçu de ${socket.clientType} (ID: ${clientId})`);
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
          // Allumer la lampe sur l'autre ESP
          const otherEsps = socket.clientType === 'esp32-cam' ? clients.espStandards : clients.espCams;
          const otherQueue = socket.clientType === 'esp32-cam' ? espStandardCommandsQueue : espCamCommandsQueue;
          otherEsps.forEach((otherEsp) => {
            if (otherEsp.readyState === WebSocket.OPEN) {
              sendJsonMessage(otherEsp, 'turn_on_light', { reason: 'alert_detected' });
            } else {
              otherQueue.push({ type: 'turn_on_light', params: { reason: 'alert_detected' } });
            }
          });
          // Forward à Androids
          broadcastAlertToAndroids(msg);
        } else if (type === 'pong') {
          console.log(`Pong reçu de ${socket.clientType} (ID: ${clientId})`);
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
        broadcastAlertToAndroids('Photo capturée lors d\'une alerte', message);
      } else {
        console.error(`Image reçue d'un client non ESP-CAM (type: ${socket.clientType}, ID: ${clientId})`);
        sendJsonMessage(socket, 'error', { message: 'Seuls les ESP32-CAM peuvent envoyer des images' });
      }
    }
  });

  socket.on('close', () => {
    clearTimeout(registrationTimeout);
    clearInterval(pingInterval);
    console.log(`${getClientType(socket)} déconnecté (ID: ${clientId})`);
    // Supprimer de la liste
    clients.androids.delete(clientId);
    clients.espCams = clients.espCams.filter(s => s !== socket);
    clients.espStandards = clients.espStandards.filter(s => s !== socket);
    // Notifier Androids si ESP déconnecté
    if (socket.clientType === 'esp32-cam') {
      broadcastEspStatus('espCam', clients.espCams.length > 0);
    } else if (socket.clientType === 'esp32-standard') {
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
