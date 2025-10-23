const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const MAX_QUEUE_SIZE = 50; // Limite de taille pour les files d'attente de photos

// --- Serveur HTTP et WebSocket ---
// Un serveur HTTP simple pour les vérifications de statut
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket actif\n');
});

// Le serveur WebSocket
const wss = new WebSocket.Server({ server });

// --- Stockage des clients (Utilisation de Map pour plusieurs Androids) ---
const clients = {
    // Androids: Map<clientId, { socket }> pour supporter plusieurs téléphones
    androids: new Map(),        
    // ESPs: un seul client à la fois pour le moment
    espCam: null,         
    espStandard: null     
};

// --- Files d'attente (Stocke les données binaires des photos pour Android déconnecté) ---
const photoQueue = []; 

// --- Statut des ESP ---
let espCamConnected = false;
let espStandardConnected = false;

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
 * Envoie le statut de connexion des ESPs à TOUS les Androids connectés (Exigence 4).
 */
function broadcastEspStatus() {
    espCamConnected = clients.espCam !== null;
    espStandardConnected = clients.espStandard !== null;

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
 * Envoie une commande de l'Android aux ESP32 (Exigence 6).
 */
function distributeCommand(type, params, androidSocket) {
    let sentToCam = false;
    let sentToStd = false;
    const messageToSend = { type, params };

    // Envoyer à ESP32-CAM (pour network_config et security_config)
    if (clients.espCam && clients.espCam.readyState === WebSocket.OPEN) {
        clients.espCam.send(JSON.stringify(messageToSend));
        sentToCam = true;
    }

    // Envoyer à ESP32-Standard (pour network_config et security_config)
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(JSON.stringify(messageToSend));
        sentToStd = true;
    }
    
    // Réponse à l'Android
    if (androidSocket && androidSocket.readyState === WebSocket.OPEN) {
        const camStatus = sentToCam ? 'OK' : 'Non connecté';
        const stdStatus = sentToStd ? 'OK' : 'Non connecté';
        const msg = `${type} envoyé. CAM: ${camStatus}, STD: ${stdStatus}`;

        sendJsonMessage(androidSocket, 'command_response', { success: true, message: msg });
    }
}

/**
 * Envoie un message JSON spécifique à l'ESP Standard (pour allumer la lampe, Exigence 2 et 5).
 */
function sendToEspStandard(message) {
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(JSON.stringify(message));
    }
}

/**
 * Transfère les données binaires (image) à tous les Androids (Exigence 2 et 3).
 * @param {Buffer} data - Données d'image binaires
 */
function broadcastImage(data) {
    let sentToAndroid = false;
    
    // Transfère l'image à tous les Androids connectés
    clients.androids.forEach(client => {
        if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(data);
            sentToAndroid = true;
        }
    });

    // Mise en file d'attente si aucun Android n'est connecté (Exigence 3)
    if (!sentToAndroid && photoQueue.length < MAX_QUEUE_SIZE) {
        photoQueue.push(data); 
        console.log(`Android non connecté, photo mise en file d'attente (${photoQueue.length}/${MAX_QUEUE_SIZE}).`);
    }

    // Envoyer commande pour allumer la lampe à ESP-Standard (Exigence 2)
    sendToEspStandard({ type: 'turn_on_light' });
}

/**
 * Envoie toutes les photos en file d'attente à l'Android nouvellement connecté (Exigence 3).
 */
function sendQueuedPhotos(androidSocket) {
    let count = 0;
    while (photoQueue.length > 0) {
        const photo = photoQueue.shift();
        androidSocket.send(photo);
        count++;
    }
    if (count > 0) {
         console.log(`${count} photo(s) en file d'attente envoyée(s) à Android.`);
    }
}

// --- Gestion des connexions WebSocket ---

wss.on('connection', (socket, req) => {
    const clientId = uuidv4();
    socket.clientId = clientId;
    socket.clientType = null;
    
    // Le registrationTimeout a été retiré pour la stabilité sur Render et éviter les déconnexions forcées.

    socket.on('message', (data) => {
        try {
            let message;
            let isBinary = Buffer.isBuffer(data);

            // 1. Traitement des données binaires (Image ESP-CAM - Exigence 2)
            if (isBinary) {
                if (socket.clientType !== 'esp32-cam') return; 
                console.log(`Photo reçue de ESP-CAM (ID: ${clientId}), taille: ${data.length} bytes`);
                broadcastImage(data); // Relais à Android et gestion file d'attente/lampe
                return;
            }

            // 2. Traitement des messages JSON
            message = JSON.parse(data.toString());
            const type = message.type;
            
            // Enregistrement
            if (type === 'register') {
                const device = message.device;
                socket.clientType = device;
                
                if (device === 'android') {
                    // Supporte plusieurs Androids
                    clients.androids.set(clientId, { socket }); 
                    sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
                    sendQueuedPhotos(socket); // Envoi des photos en attente (Exigence 3)
                    broadcastEspStatus();
                } else if (device === 'esp32-cam') {
                    clients.espCam = socket;
                    broadcastEspStatus(); 
                    sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
                } else if (device === 'esp32-standard') {
                    clients.espStandard = socket;
                    broadcastEspStatus();
                    sendJsonMessage(socket, 'registered', { message: 'Enregistrement réussi' });
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
            
            // Alertes ESP (Exigence 5)
            if ((socket.clientType === 'esp32-cam' || socket.clientType === 'esp32-standard') && type === 'alert') {
                console.log(`Alerte reçue de ${socket.clientType}: ${message.message}`);
                
                // Relais à tous les Androids
                clients.androids.forEach(client => {
                    sendJsonMessage(client.socket, 'alert', { message: message.message });
                });
                
                // Envoi commande pour allumer la lampe (Exigence 5)
                sendToEspStandard({ type: 'turn_on_light' });
                return;
            }
            
            // Commandes Android (Exigence 6)
            if (socket.clientType === 'android' && (type === 'network_config' || type === 'security_config')) {
                distributeCommand(type, message.params || {}, socket);
                return;
            }
            
            // Heartbeat (Ping/Pong) pour maintenir la connexion active
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
            clients.espCam = null;
            broadcastEspStatus(); // Informe Androids de la déconnexion
        } else if (type === 'esp32-standard') {
            clients.espStandard = null;
            broadcastEspStatus(); // Informe Androids de la déconnexion
        }
        console.log(`Client déconnecté (ID: ${clientId}, Type: ${type || 'Unknown'}, Code: ${code})`);
    });

    socket.on('error', (error) => {
        console.error(`Erreur WebSocket (ID: ${clientId}):`, error);
    });
});

// Lancer le serveur
server.listen(PORT, () => {
    console.log(`Serveur actif sur port ${PORT}. Écoute HTTP et WS.`);
});
