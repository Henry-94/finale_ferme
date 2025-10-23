const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// Configuration du serveur HTTP minimal
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Farm Intelligent Server</h1><p>WebSocket server running</p>');
});

const wss = new WebSocket.Server({ server });
const PORT = 10000;

// --- Objets pour gérer les clients et files d'attente ---
const clients = {
  androids: new Map(),        // Map: clientId -> WebSocket
  espCams: new Map(),         // Map: clientId -> WebSocket
  espStandards: new Map()    // Map: clientId -> WebSocket
};

const espCamCommandsQueue = [];
const espStandardCommandsQueue = [];
const pendingAlerts = []; // Stocke { message, imageData } si aucun Android

// --- Fonctions utilitaires ---

/**
 * Envoie un message JSON à un socket spécifique.
 */
function sendJsonMessage(socket, type, data = {}) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      const message = JSON.stringify({ type, ...data });
      socket.send(message);
      return true;
    } catch (e) {
      console.error(`Erreur JSON/envoi à ${socket.clientId}:`, e.message);
      return false;
    }
  }
  return false;
}

/**
 * Obtient le statut actuel des ESPs.
 */
function getEspStatus() {
  return {
    espCam: clients.espCams.size > 0,
    espStandard: clients.espStandards.size > 0
  };
}

/**
 * Broadcast le statut des ESPs à tous les Androids.
 */
function broadcastEspStatus() {
  const status = getEspStatus();
  const androidStatusMessage = {
    type: 'esp_status',
    connected: status.espCam // Votre Android n'écoute que "connected"
    // NOTE: Votre AndroidManager n'écoute que 'connected' dans "esp_status".
    // Si vous voulez les deux, modifiez l'Android pour lire 'espCam' et 'espStandard'
    // du JSON 'esp_status', que je peux aussi fournir.
    // Pour l'instant, je fais correspondre à votre Android Manager actuel:
  };
  
  clients.androids.forEach((androidSocket) => {
    sendJsonMessage(androidSocket, androidStatusMessage.type, androidStatusMessage);
  });
}

/**
 * Broadcast une alerte/image à tous les Androids, stocke si déconnecté.
 */
function broadcastAlertToAndroids(message, imageData = null) {
  const androidsConnected = clients.androids.size > 0;
  
  // 1. Tenter l'envoi
  if (androidsConnected) {
    clients.androids.forEach((androidSocket) => {
      if (androidSocket.readyState === WebSocket.OPEN) {
        try {
          // 1.1. Envoi de l'image binaire (si présente)
          if (imageData) {
            androidSocket.send(imageData); 
          }
          // 1.2. Envoi du message JSON de l'alerte
          sendJsonMessage(androidSocket, 'alert', { message });
        } catch (error) {
          console.error(`Erreur envoi alerte/image à Android:`, error.message);
        }
      }
    });
  }
  
  // 2. Stocker si personne n'est connecté
  if (!androidsConnected) {
    if (pendingAlerts.length < 50) { // Limite de 50 alertes en attente
      console.log('Aucun Android connecté. Alerte stockée:', message);
      pendingAlerts.push({ message, imageData, timestamp: Date.now() });
    } else {
      console.warn('File d\'alertes pleine, alerte ignorée:', message);
    }
  }
}

/**
 * Retente l'envoi des alertes/images en attente à tous les Androids connectés.
 */
function retryPendingAlerts() {
  if (pendingAlerts.length === 0 || clients.androids.size === 0) return;

  const alertsToSend = pendingAlerts.splice(0, pendingAlerts.length);
  console.log(`Tentative de renvoi de ${alertsToSend.length} alerte(s) en attente.`);

  alertsToSend.forEach(alert => {
    // Utiliser la fonction de broadcast qui gère la réinsertion si l'envoi échoue
    // Cependant, comme clients.androids.size > 0 ici, l'envoi devrait réussir
    // si la socket est ouverte.
    broadcastAlertToAndroids(alert.message, alert.imageData);
  });
}

/**
 * Envoie une commande Android à tous les ESPs.
 */
function distributeCommand(type, params, androidSocket) {
  const command = { type, params };
  let sentToCam = false;
  let sentToStd = false;

  // 1. Envoyer à ESP32-CAM
  clients.espCams.forEach((espSocket) => {
    if (sendJsonMessage(espSocket, type, params)) {
      sentToCam = true;
    }
  });

  // Ajouter à la queue si aucun CAM n'est connecté
  if (!sentToCam) {
    espCamCommandsQueue.push(command);
  }

  // 2. Envoyer à ESP32-Standard
  clients.espStandards.forEach((espSocket) => {
    if (sendJsonMessage(espSocket, type, params)) {
      sentToStd = true;
    }
  });

  // Ajouter à la queue si aucun Standard n'est connecté
  if (!sentToStd) {
    espStandardCommandsQueue.push(command);
  }

  // 3. Réponse à l'Android (compatible avec onCommandResponse)
  const message = `${type} envoyé. CAM: ${sentToCam ? 'OK' : 'Queue'}, STD: ${sentToStd ? 'OK' : 'Queue'}`;
  sendJsonMessage(androidSocket, 'command_response', { success: true, message });
}

/**
 * Envoie une commande aux ESPs en file d'attente lors de la connexion.
 */
function sendQueuedCommands(socket, isCam) {
  const queue = isCam ? espCamCommandsQueue : espStandardCommandsQueue;
  console.log(`Envoi de ${queue.length} commande(s) en attente au nouveau ${isCam ? 'ESP-CAM' : 'ESP-Standard'}.`);
  while (queue.length > 0) {
    const cmd = queue.shift();
    sendJsonMessage(socket, cmd.type, cmd.params);
  }
}

// --- Gestion des connexions WebSocket ---

wss.on('connection', (socket, req) => {
  const clientId = uuidv4();
  socket.clientId = clientId;
  socket.clientType = null;
  const clientIp = req.socket.remoteAddress;
  console.log(`🔗 Nouveau client connecté depuis ${clientIp} (ID: ${clientId})`);

  // Timeout pour forcer l'enregistrement
  const registrationTimeout = setTimeout(() => {
    if (!socket.clientType && socket.readyState === WebSocket.OPEN) {
      console.log(`Client ${clientId} non enregistré après 15s, fermeture.`);
      sendJsonMessage(socket, 'error', { message: 'Enregistrement requis (Timeout)' });
      socket.close(1008, 'Non enregistré');
    }
  }, 15000);

  socket.on('message', (message) => {
    // --- 1. GESTION DE L'ENREGISTREMENT ---
    if (!socket.clientType) {
      if (typeof message === 'string') {
        try {
          const data = JSON.parse(message);
          if (data.type === 'register') {
            clearTimeout(registrationTimeout);
            const device = data.device;
            socket.clientType = device;
            
            console.log(`✅ Client ID ${clientId} enregistré comme: ${device}`);

            if (device === 'android') {
              clients.androids.set(clientId, socket);
              sendJsonMessage(socket, 'registered', { message: 'OK' });
              broadcastEspStatus(); // Envoyer statut ESPs à Android
              retryPendingAlerts(); // Envoyer alertes en attente
            } else if (device === 'esp32-cam') {
              clients.espCams.set(clientId, socket);
              sendJsonMessage(socket, 'registered', { message: 'OK' });
              sendQueuedCommands(socket, true); // Envoyer commandes en attente
              broadcastEspStatus();
            } else if (device === 'esp32-standard') {
              clients.espStandards.set(clientId, socket);
              sendJsonMessage(socket, 'registered', { message: 'OK' });
              sendQueuedCommands(socket, false); // Envoyer commandes en attente
              broadcastEspStatus();
            } else {
              socket.close(1008, 'Type d\'appareil inconnu');
            }
            return;
          } else {
            console.warn(`Message non-register reçu avant enregistrement (ID: ${clientId}). Ignoré.`);
            return;
          }
        } catch (error) {
          console.error(`Erreur parsing JSON avant enregistrement (ID: ${clientId}):`, error.message);
          return;
        }
      } else if (message instanceof Buffer) {
        console.warn(`Données binaires reçues AVANT enregistrement (ID: ${clientId}). Ignoré.`);
        return;
      }
    }

    // --- 2. GESTION DES MESSAGES POST-ENREGISTREMENT ---

    // Alerte avec image depuis ESP-CAM
    if (message instanceof Buffer) {
      if (socket.clientType === 'esp32-cam') {
        // L'image est transmise seule, l'alerte doit suivre juste après.
        // On utilise une alerte par défaut en attendant l'alerte JSON
        console.log(`Image reçue de ESP-CAM (ID: ${clientId}), taille: ${message.length} bytes`);
        broadcastAlertToAndroids('Photo d\'alerte reçue', message);
      } else {
        console.error(`Données binaires reçues d'un client non-CAM: ${socket.clientType}`);
      }
      return;
    }
    
    // Messages JSON
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message);
        const type = data.type;
        console.log(`Message JSON reçu de ${socket.clientType} (ID: ${clientId}): ${type}`);

        // Commandes depuis Android (network_config, security_config)
        if (socket.clientType === 'android') {
          if (type === 'network_config' || type === 'security_config') {
            distributeCommand(type, data.params || {}, socket);
          } else if (type === 'pong') {
            // Réponse au ping du serveur
          } else {
            console.warn(`Type de commande Android inconnu: ${type}`);
          }
          return;
        }

        // Alertes depuis ESPs
        if (type === 'alert' && (socket.clientType === 'esp32-cam' || socket.clientType === 'esp32-standard')) {
          const msg = data.message || 'Alerte sans message';
          console.log(`Alerte reçue de ${socket.clientType}: ${msg}`);
          
          // 1. Transfert à Android (seulement le message ici, l'image est binaire)
          broadcastAlertToAndroids(msg);
          
          // 2. Action de sécurité: Allumer la lampe sur l'autre ESP
          const isCamAlert = socket.clientType === 'esp32-cam';
          const targetEsps = isCamAlert ? clients.espStandards : clients.espCams;
          const targetQueue = isCamAlert ? espStandardCommandsQueue : espCamCommandsQueue;

          let sentLightCommand = false;
          targetEsps.forEach(otherEsp => {
            if (sendJsonMessage(otherEsp, 'turn_on_light', { reason: 'alert_detected' })) {
              sentLightCommand = true;
            }
          });
          if (!sentLightCommand) {
            targetQueue.push({ type: 'turn_on_light', params: { reason: 'alert_detected' } });
            console.log(`Commande 'turn_on_light' mise en file d'attente pour l'autre ESP.`);
          }
          return;
        }
        
        // Ping/Pong ESP
        if (type === 'pong') { 
          // Réponse au ping du serveur (si les ESPs le gèrent)
          return; 
        }
        
      } catch (error) {
        console.error(`Erreur parsing JSON pour client ${clientId}:`, error.message);
        sendJsonMessage(socket, 'error', { message: 'Message JSON invalide' });
      }
    }
  });

  socket.on('close', () => {
    clearTimeout(registrationTimeout); 
    
    const type = socket.clientType;
    
    // Suppression du client
    if (type === 'android') {
      clients.androids.delete(clientId);
    } else if (type === 'esp32-cam') {
      clients.espCams.delete(clientId);
      broadcastEspStatus();
    } else if (type === 'esp32-standard') {
      clients.espStandards.delete(clientId);
      broadcastEspStatus();
    }
    
    console.log(`💔 ${type || 'Unknown'} déconnecté (ID: ${clientId})`);
  });

  socket.on('error', (error) => {
    console.error(`Erreur WebSocket pour client ${clientId}:`, error.message);
  });
});

// Retry périodique des alertes en attente (toutes les 30 secondes)
setInterval(retryPendingAlerts, 30000);

// Démarrer le serveur
server.listen(PORT, () => {
  console.log(`🚀 Serveur actif sur port ${PORT}. Écoute HTTP et WS.`);
});

// Gestion du Ping/Pong pour les clients Android et ESPs
const pingInterval = setInterval(() => {
  const activeClients = [...clients.androids.values(), ...clients.espCams.values(), ...clients.espStandards.values()];
  activeClients.forEach(socket => {
    if (socket.readyState === WebSocket.OPEN) {
      sendJsonMessage(socket, 'ping');
    }
  });
}, 30000); // Envoi d'un ping toutes les 30 secondes
