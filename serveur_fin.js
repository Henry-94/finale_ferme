const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const MAX_QUEUE_SIZE = 50; // Limite de taille pour les files d'attente

// --- Serveur HTTP et WebSocket ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket actif\n');
});

const wss = new WebSocket.Server({ server });

// --- Stockage des clients (Utilisation de Map pour plusieurs clients Android) ---
const clients = {
    androids: new Map(),        // Map: clientId -> { socket, isAlive }
    espCams: new Map(),         // Map: clientId -> { socket, isAlive }
    espStandards: new Map()     // Map: clientId -> { socket, isAlive }
};

// --- Files d'attente ---
const photoQueue = [];              // Stocke les données binaires des photos
const espCamCommandsQueue = [];     // Stocke les commandes Android pour les ESP-CAM déconnectés
const espStandardCommandsQueue = [];// Stocke les commandes Android pour les ESP-Standard déconnectés

// --- Fonctions utilitaires ---

/**
 * Envoie un message JSON à un socket spécifique.
 */
function sendJsonMessage(socket, type, data = {}) {
    if (socket && socket.readyState === WebSocket.OPEN) {
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
 * Broadcast le statut des ESPs à tous les Androids connectés.
 */
function broadcastEspStatus() {
    const espCamConnected = clients.espCams.size > 0;
    const espStandardConnected = clients.espStandards.size > 0;

    const statusMessage = {
        type: 'esp_status',
        espCam: espCamConnected,
        espStandard: espStandardConnected,
        connected: espCamConnected || espStandardConnected 
    };

    clients.androids.forEach(client => {
        sendJsonMessage(client.socket, statusMessage.type, statusMessage);
    });
}

/**
 * Distribue une commande à tous les ESPs du type spécifié, ou la met en file d'attente.
 */
function distributeCommand(type, params, androidSocket) {
    const command = { type, params };
    let sentToCam = false;
    let sentToStd = false;

    // 1. Envoyer à ESP32-CAM
    clients.espCams.forEach(client => {
        if (sendJsonMessage(client.socket, type, params)) {
            sentToCam = true;
        }
    });

    // Mettre en file d'attente si aucun CAM n'est connecté
    if (!sentToCam && espCamCommandsQueue.length < MAX_QUEUE_SIZE) {
        espCamCommandsQueue.push(command);
    }

    // 2. Envoyer à ESP32-Standard
    clients.espStandards.forEach(client => {
        if (sendJsonMessage(client.socket, type, params)) {
            sentToStd = true;
        }
    });

    // Mettre en file d'attente si aucun Standard n'est connecté
    if (!sentToStd && espStandardCommandsQueue.length < MAX_QUEUE_SIZE) {
        espStandardCommandsQueue.push(command);
    }
    
    // 3. Réponse à l'Android
    if (androidSocket) {
        const message = `${type} envoyé. CAM: ${sentToCam ? 'OK' : 'Queue'}, STD: ${sentToStd ? 'OK' : 'Queue'}`;
        sendJsonMessage(androidSocket, 'command_response', { success: true, message });
    }
}

/**
 * Envoie toutes les photos en file d'attente à l'Android nouvellement connecté.
 */
function sendQueuedPhotos(androidSocket) {
    while (photoQueue.length > 0) {
        const photo = photoQueue.shift();
        androidSocket.send(photo);
        console.log(`Photo en file d'attente envoyée à Android (taille: ${photo.length} bytes)`);
    }
}

/**
 * Envoie toutes les commandes en file d'attente à l'ESP nouvellement connecté.
 */
function sendQueuedCommands(espSocket, isCam) {
    const queue = isCam ? espCamCommandsQueue : espStandardCommandsQueue;
    console.log(`Envoi de ${queue.length} commande(s) en attente au nouveau ${isCam ? 'ESP-CAM' : 'ESP-Standard'}.`);
    while (queue.length > 0) {
        const cmd = queue.shift();
        sendJsonMessage(espSocket, cmd.type, cmd.params);
    }
}

// --- Gestion des connexions WebSocket ---

wss.on('connection', (socket, req) => {
    const clientId = uuidv4();
    socket.clientId = clientId;
    socket.clientType = null;
    socket.isAlive = true; // Conserver 'isAlive' pour la gestion interne (si besoin)
    
    //  Heartbeat serveur désactivé. Le client Android doit envoyer des PING.

    // Gère le PONG si le client Android envoie un PING
    socket.on('pong', () => {
        // OkHttp gère le pong en réponse au ping du serveur.
        // Si vous utilisez un ping manuel client, ce 'pong' n'est pas nécessaire ici.
        // Mais nous le gardons par sécurité.
        socket.isAlive = true;
    });

    socket.on('message', (data) => {
        try {
            // --- Traitement des données binaires (Photo ESP-CAM) ---
            if (Buffer.isBuffer(data)) {
                if (socket.clientType !== 'esp32-cam') return; 

                console.log(`Photo reçue de ESP-CAM (ID: ${clientId}), taille: ${data.length} bytes`);
                
                let sentToAndroid = false;
                clients.androids.forEach(client => {
                    if (client.socket.readyState === WebSocket.OPEN) {
                        client.socket.send(data);
                        sentToAndroid = true;
                    }
                });

                if (!sentToAndroid && photoQueue.length < MAX_QUEUE_SIZE) {
                    photoQueue.push(data);
                    console.log(`Android non connecté, photo mise en file d'attente.`);
                }
                
                // Envoyer la commande d'allumage de la lampe à ESP-Standard
                distributeCommand('turn_on_light', { reason: 'alert_image' }, null); 
                return;
            }

            // --- Traitement des messages JSON ---
            const message = JSON.parse(data.toString());
            const type = message.type;
            
            // 1. Enregistrement
            if (type === 'register') {
                const device = message.device;
                socket.clientType = device;
                
                // Retrait des anciennes références avant d'ajouter la nouvelle
                clients.androids.delete(clientId);
                clients.espCams.delete(clientId);
                clients.espStandards.delete(clientId);
                
                if (device === 'android') {
                    clients.androids.set(clientId, { socket, isAlive: true });
                    sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
                    broadcastEspStatus();
                    sendQueuedPhotos(socket);
                } else if (device === 'esp32-cam') {
                    clients.espCams.set(clientId, { socket, isAlive: true });
                    sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
                    sendQueuedCommands(socket, true);
                    broadcastEspStatus();
                } else if (device === 'esp32-standard') {
                    clients.espStandards.set(clientId, { socket, isAlive: true });
                    sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
                    sendQueuedCommands(socket, false);
                    broadcastEspStatus();
                } else {
                    socket.close(1000, 'Type de dispositif inconnu');
                }
                console.log(`Client ID ${clientId} enregistré comme: ${device}`);
                return;
            }
            
            // Si pas encore enregistré, ignorer les autres messages
            if (!socket.clientType) {
                console.warn(`Message reçu avant enregistrement. Type: ${type}`);
                return;
            }
            
            // 2. Commandes Android
            if (socket.clientType === 'android' && (type === 'network_config' || type === 'security_config')) {
                distributeCommand(type, message.params || {}, socket);
                return;
            }
            
            // 3. Alertes ESP
            if ((socket.clientType === 'esp32-cam' || socket.clientType === 'esp32-standard') && type === 'alert') {
                console.log(`Alerte reçue de ${socket.clientType}: ${message.message}`);
                
                clients.androids.forEach(client => {
                    sendJsonMessage(client.socket, 'alert', { message: message.message });
                });
                
                distributeCommand('turn_on_light', { reason: 'alert_detected' }, null);
                return;
            }
            
            // 4. Ping/Pong (Répondre au ping manuel du client Android)
            if (type === 'ping') {
                sendJsonMessage(socket, 'pong');
                return;
            }

            console.log(`Message non géré de ${socket.clientType}: ${JSON.stringify(message)}`);

        } catch (error) {
            console.error(`Erreur traitement message (ID: ${clientId}):`, error.message);
        }
    });

    socket.on('close', (code, reason) => {
        const type = socket.clientType;
        if (type === 'android') {
            clients.androids.delete(clientId);
        } else if (type === 'esp32-cam') {
            clients.espCams.delete(clientId);
            broadcastEspStatus();
        } else if (type === 'esp32-standard') {
            clients.espStandards.delete(clientId);
            broadcastEspStatus();
        }
        console.log(`Client déconnecté (ID: ${clientId}, Type: ${type || 'Unknown'}, Code: ${code})`);
    });

    socket.on('error', (error) => {
        console.error(`Erreur WebSocket (ID: ${clientId}):`, error);
    });
});

// --- Désactivation du Heartbeat Côté Serveur ---

// Commenté pour s'adapter à votre code Android qui gère manuellement le ping.
// const pingInterval = setInterval(() => { ... }, PING_INTERVAL_MS);
// wss.on('close', () => { clearInterval(pingInterval); }); 

// Lancer le serveur
server.listen(PORT, () => {
    console.log(`Serveur actif sur port ${PORT}. Écoute HTTP et WS.`);
});
