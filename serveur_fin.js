const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const MAX_QUEUE_SIZE = 50; 

// --- Serveur HTTP et WebSocket ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket actif\n');
});

const wss = new WebSocket.Server({ server });

// --- Stockage des clients (Utilisation de Map pour les Androids) ---
const clients = {
    // Permet plusieurs téléphones Androids
    androids: new Map(),        
    // ESPs: une seule instance à la fois (pour l'instant)
    espCam: null,         
    espStandard: null     
};

// --- Files d'attente ---
const photoQueue = []; // Photos pour Android déconnecté (Exigence: tenter toujours d'envoyer)

// --- Statut des ESP ---
let espCamConnected = false;
let espStandardConnected = false;

// --- Fonctions utilitaires ---

/**
 * Envoie le statut de connexion des ESPs à TOUS les Androids connectés (Exigence: Transmettre statut).
 */
function broadcastEspStatus() {
    espCamConnected = clients.espCam !== null;
    espStandardConnected = clients.espStandard !== null;

    const statusMessage = {
        type: 'esp_status',
        espCam: espCamConnected,
        espStandard: espStandardConnected,
        connected: espCamConnected || espStandardConnected // Reste pour compatibilité
    };

    clients.androids.forEach(client => {
        if (client.socket.readyState === WebSocket.OPEN) {
             client.socket.send(JSON.stringify(statusMessage));
        }
    });
}

/**
 * Envoie un message JSON spécifique à l'ESP Standard (Utilisé pour la lampe).
 */
function sendToEspStandard(message) {
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(JSON.stringify(message));
    }
}

/**
 * Transfère les données binaires (image) à tous les Androids (Exigence: Photo/Alerte transférée).
 * Gère la file d'attente et la commande de lampe (Exigence: Lampe auto + Tenter toujours d'envoyer).
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

    // Mise en file d'attente si aucun Android n'est connecté
    if (!sentToAndroid && photoQueue.length < MAX_QUEUE_SIZE) {
        photoQueue.push(data); 
        console.log(`Android non connecté, photo mise en file d'attente (${photoQueue.length}/${MAX_QUEUE_SIZE}).`);
    }

    // Envoyer commande pour allumer la lampe à ESP-Standard
    sendToEspStandard({ type: 'turn_on_light' });
}


/**
 * Envoie toutes les photos en file d'attente à l'Android nouvellement connecté.
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
    const clientIp = req.socket.remoteAddress;
    
    // ⚠️ SUPPRESSION DU registrationTimeout pour la stabilité et la robustesse

    socket.on('message', (data) => {
        try {
            let message;
            let isBinary = Buffer.isBuffer(data);

            // 1. Traitement des données binaires (Image ESP-CAM - Exigence: Photo binaire)
            if (isBinary) {
                if (socket.clientType !== 'esp32-cam') return; 
                console.log(`Photo reçue de ESP-CAM (ID: ${clientId}), taille: ${data.length} bytes`);
                broadcastImage(data); // Relais, file d'attente et commande de lampe
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
                    // Utilisation de Map pour plusieurs Androids
                    clients.androids.set(clientId, { socket }); 
                    socket.send(JSON.stringify({ type: 'registered', message: 'Enregistrement réussi' }));
                    sendQueuedPhotos(socket); // Envoi des photos en attente
                    broadcastEspStatus();
                } else if (device === 'esp32-cam') {
                    clients.espCam = socket;
                    socket.send(JSON.stringify({ type: 'registered', message: 'Enregistrement réussi' }));
                    broadcastEspStatus(); 
                } else if (device === 'esp32-standard') {
                    clients.espStandard = socket;
                    socket.send(JSON.stringify({ type: 'registered', message: 'Enregistrement réussi' }));
                    broadcastEspStatus();
                } else {
                    socket.close(1000, 'Type de dispositif inconnu');
                }
                console.log(`✅ Client ID ${clientId} enregistré comme: ${device}`);
                return;
            }
            
            // Si pas encore enregistré, ignorer les autres messages
            if (!socket.clientType) {
                console.warn(`Message reçu avant enregistrement. Type: ${type}`);
                return;
            }
            
            // Alertes ESP (Exigence: Alerte transférée + Lampe auto)
            if ((socket.clientType === 'esp32-cam' || socket.clientType === 'esp32-standard') && type === 'alert') {
                console.log(`Alerte reçue de ${socket.clientType}: ${message.message}`);
                
                // Relais à tous les Androids
                clients.androids.forEach(client => {
                    if (client.socket.readyState === WebSocket.OPEN) {
                        client.socket.send(JSON.stringify(message));
                    }
                });
                
                // Envoi commande pour allumer la lampe
                sendToEspStandard({ type: 'turn_on_light' });
                return;
            }
            
            // Commandes Android (Exigence: network_config et security_config)
            if (socket.clientType === 'android' && (type === 'network_config' || type === 'security_config')) {
                // Transférer à ESP32-CAM et ESP32-Standard
                const params = message.params || {};
                let sentToCam = false;
                let sentToStd = false;
                
                if (clients.espCam && clients.espCam.readyState === WebSocket.OPEN) {
                    clients.espCam.send(JSON.stringify(message));
                    sentToCam = true;
                }
                if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
                    clients.espStandard.send(JSON.stringify(message));
                    sentToStd = true;
                }
                
                // Confirmer à l'application Android
                socket.send(JSON.stringify({
                    type: 'command_response',
                    success: true,
                    // Mise à jour de la réponse pour être plus clair
                    message: `${type} envoyé. CAM: ${sentToCam ? 'OK' : 'Non connecté'}, STD: ${sentToStd ? 'OK' : 'Non connecté'}`
                }));
                return;
            }
            
            // Heartbeat (Ping/Pong)
            if (type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            console.log(`Message non géré de ${socket.clientType}: ${JSON.stringify(message)}`);

        } catch (error) {
            console.error(`Erreur traitement message (ID: ${clientId}):`, error.message);
            socket.send(JSON.stringify({ type: 'error', message: 'Erreur serveur: ' + error.message }));
        }
    });

    socket.on('close', (code, reason) => {
        const type = socket.clientType;
        
        if (type === 'android') {
            clients.androids.delete(clientId); 
        } else if (type === 'esp32-cam') {
            clients.espCam = null;
            broadcastEspStatus();
        } else if (type === 'esp32-standard') {
            clients.espStandard = null;
            broadcastEspStatus();
        }
        console.log(`💔 Client déconnecté (ID: ${clientId}, Type: ${type || 'Unknown'}, Code: ${code})`);
    });

    socket.on('error', (error) => {
        console.error(`Erreur WebSocket (ID: ${clientId}):`, error);
    });
});

// Lancer le serveur
server.listen(PORT, () => {
    console.log(`🚀 Serveur actif sur port ${PORT}. Écoute HTTP et WS.`);
});
