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

// File d'attente pour les alertes/images si aucun Android n'est connecté
const pendingAlerts = [];

// Fonction pour envoyer un message JSON à un client spécifique
function sendJsonMessage(socket, type, data = {}) {
  if (socket.readyState === WebSocket.OPEN) {
    const message = JSON.stringify({ type, ...data });
    socket.send(message);
    console.log(`Message envoyé à ${getClientType(socket)}: ${message}`);
  }
}

// Fonction pour obtenir le type de client (pour logging)
function getClientType(socket) {
  if (clients.androids.has(socket.clientId)) return 'Android';
  if (clients.espCams.includes(socket)) return 'ESP-CAM';
  if (clients.espStandards.includes(socket)) return 'ESP-Standard';
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
          console.error('Erreur envoi à Android:', error.message);
        }
      }
    });
  } else {
    // Stocker l'alerte pour retry
    console.log('Aucun Android connecté. Alerte stockée pour retry:', message);
    pendingAlerts.push({ message, imageData });
  }
}

// Fonction pour retenter l'envoi des alertes/images
function retryPendingAlerts() {
  if (pendingAlerts.length === 0 || clients.androids.size === 0) return;

  const alertsToSend = [...pendingAlerts];
  pendingAlerts.length = 0; // Vider la file après copie

  alertsToSend.forEach(({ message, imageData }) => {
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

// Gestion des connexions WebSocket
wss.on('connection', (socket, req) => {
  const clientId = uuidv4();
  socket.clientId = clientId; // Ajouter un ID pour les Androids
  const clientIp = req.socket.remoteAddress;
  console.log(`Nouveau client connecté depuis ${clientIp} (ID: ${clientId})`);

  // Ping périodique pour maintenir la connexion
  const pingInterval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        sendJsonMessage(socket, 'ping');
      } catch (e) {
        console.error('Erreur ping:', e.message);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  socket.on('message', (message) => {
    if (typeof message === 'string') {
      // Message JSON
      try {
        const data = JSON.parse(message);
        const type = data.type;

        // Enregistrement du client
        if (type === 'register') {
          const device = data.device;
          if (device === 'android') {
            clients.androids.set(clientId, socket);
            console.log('Android connecté');
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
            console.log('ESP32-CAM connecté');
            sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
            broadcastEspStatus('espCam', true);
          } else if (device === 'esp32-standard') {
            clients.espStandards.push(socket);
            console.log('ESP32-Standard connecté');
            sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
            broadcastEspStatus('espStandard', true);
          } else {
            sendJsonMessage(socket, 'error', { message: `Type d'appareil inconnu: ${device}` });
          }
          return;
        }

        // Commandes depuis Android
        if (clients.androids.has(clientId)) {
          if (type === 'network_config') {
            const params = data.params || {};
            console.log('Commande réseau reçue:', params);
            // Forward aux ESPs
            [...clients.espCams, ...clients.espStandards].forEach((espSocket) => {
              sendJsonMessage(espSocket, 'network_config', params);
            });
            sendJsonMessage(socket, 'command_response', { success: true, message: 'Commande réseau envoyée aux ESPs' });
          } else if (type === 'security_config') {
            const params = data.params || {};
            console.log('Commande sécurité reçue:', params);
            // Forward aux ESPs
            [...clients.espCams, ...clients.espStandards].forEach((espSocket) => {
              sendJsonMessage(espSocket, 'security_config', params);
            });
            sendJsonMessage(socket, 'command_response', { success: true, message: 'Commande sécurité envoyée aux ESPs' });
          }
          return;
        }

        // Alertes ou images depuis ESPs
        if (type === 'alert' && (clients.espCams.includes(socket) || clients.espStandards.includes(socket))) {
          const msg = data.message || 'Alerte sans message';
          console.log(`Alerte reçue de ${getClientType(socket)}: ${msg}`);
          // Allumer la lampe sur l'autre ESP
          const otherEsps = clients.espCams.includes(socket) ? clients.espStandards : clients.espCams;
          otherEsps.forEach((otherEsp) => {
            if (otherEsp.readyState === WebSocket.OPEN) {
              sendJsonMessage(otherEsp, 'turn_on_light', { reason: 'alert_detected' });
            }
          });
          // Forward à Androids
          broadcastAlertToAndroids(msg);
        } else if (type === 'pong') {
          console.log('Pong reçu de', getClientType(socket));
        } else {
          console.log(`Message non géré: ${type}`);
        }
      } catch (error) {
        console.error('Erreur parsing JSON:', error.message);
        sendJsonMessage(socket, 'error', { message: 'Message JSON invalide' });
      }
    } else if (message instanceof Buffer) {
      // Image binaire depuis ESP32-CAM
      if (clients.espCams.includes(socket)) {
        console.log(`Image binaire reçue de ESP-CAM, taille: ${message.length} bytes`);
        broadcastAlertToAndroids('Photo capturée lors d\'une alerte', message);
      } else {
        console.error('Image reçue d\'un client non ESP-CAM');
      }
    }
  });

  socket.on('close', () => {
    clearInterval(pingInterval);
    console.log(`${getClientType(socket)} déconnecté (ID: ${clientId})`);
    // Supprimer de la liste
    clients.androids.delete(clientId);
    clients.espCams = clients.espCams.filter(s => s !== socket);
    clients.espStandards = clients.espStandards.filter(s => s !== socket);
    // Notifier Androids si ESP déconnecté
    if (clients.espCams.includes(socket)) {
      broadcastEspStatus('espCam', false);
    } else if (clients.espStandards.includes(socket)) {
      broadcastEspStatus('espStandard', false);
    }
  });

  socket.on('error', (error) => {
    console.error('Erreur WebSocket:', error.message);
  });
});

// Retry périodique des alertes en attente
setInterval(retryPendingAlerts, 30000);

// Démarrer le serveur
server.listen(PORT, () => {
  console.log(` Serveur actif sur port ${PORT}. Écoute HTTP et WS.`);
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