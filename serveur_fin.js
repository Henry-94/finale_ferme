const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 10000;

// Créer un serveur HTTP pour gérer les requêtes WebSocket
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket actif\n');
});

// Créer un serveur WebSocket
const wss = new WebSocket.Server({ server });

// Stockage des clients par type
const clients = {
    android: null,
    espCam: null,
    espStandard: null
};

// File d'attente pour les photos non envoyées à l'application Android
const photoQueue = [];

// Statut des ESP
let espCamConnected = false;
let espStandardConnected = false;

function broadcastEspStatus() {
    if (clients.android && clients.android.readyState === WebSocket.OPEN) {
        const statusMessage = {
            type: 'esp_status',
            espCam: espCamConnected,
            espStandard: espStandardConnected
        };
        clients.android.send(JSON.stringify(statusMessage));
        console.log(`Message envoyé à Android: ${JSON.stringify(statusMessage)}`);
    }
}

function sendToEspStandard(message) {
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(JSON.stringify(message));
        console.log(`Message envoyé à ESP-Standard: ${JSON.stringify(message)}`);
    }
}

wss.on('connection', (socket, req) => {
    const clientId = uuidv4();
    socket.clientId = clientId;
    socket.clientType = null;
    const clientIp = req.socket.remoteAddress;
    console.log(`🔗 Nouveau client connecté depuis ${clientIp} (ID: ${clientId}, Port: ${req.socket.remotePort})`);

    // Timeout pour l'enregistrement (30s pour tolérer les délais réseau)
    const registrationTimeout = setTimeout(() => {
        if (!socket.clientType) {
            console.log(`Client ${clientId} non enregistré après 30s, fermeture connexion`);
            socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis' }));
            socket.close(1000, 'Enregistrement requis');
        }
    }, 30000);

    socket.on('message', (data) => {
        try {
            // Vérifier si les données sont binaires
            if (Buffer.isBuffer(data)) {
                if (!socket.clientType) {
                    console.log(`Données binaires reçues avant enregistrement (ID: ${clientId}), taille: ${data.length} bytes`);
                    socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis avant envoi de données binaires' }));
                    return;
                }
                if (socket.clientType === 'esp32-cam') {
                    console.log(`Photo reçue de ESP-CAM (ID: ${clientId}), taille: ${data.length} bytes`);
                    // Transférer à l'application Android si connectée
                    if (clients.android && clients.android.readyState === WebSocket.OPEN) {
                        clients.android.send(data);
                        console.log(`Photo transférée à Android (ID: ${clients.android.clientId})`);
                    } else {
                        // Mettre en file d'attente si Android non connecté
                        photoQueue.push(data);
                        console.log(`Android non connecté, photo mise en file d'attente (taille: ${data.length} bytes)`);
                    }
                    // Envoyer commande pour allumer la lampe à ESP-Standard
                    sendToEspStandard({ type: 'turn_on_light' });
                }
                return;
            }

            // Traiter les messages JSON
            const message = JSON.parse(data.toString());
            console.log(`Message JSON reçu de ${socket.clientType || 'Unknown'} (ID: ${clientId}): ${JSON.stringify(message)}`);

            if (message.type === 'register') {
                clearTimeout(registrationTimeout);
                const device = message.device;
                socket.clientType = device;

                if (device === 'android') {
                    clients.android = socket;
                    console.log('✅ Android connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'Enregistrement réussi' }));
                    // Envoyer le statut des ESP
                    broadcastEspStatus();
                    // Envoyer les photos en file d'attente
                    while (photoQueue.length > 0) {
                        const photo = photoQueue.shift();
                        socket.send(photo);
                        console.log(`Photo en file d'attente envoyée à Android (taille: ${photo.length} bytes)`);
                    }
                } else if (device === 'esp32-cam') {
                    clients.espCam = socket;
                    espCamConnected = true;
                    console.log('✅ ESP32-CAM connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'Enregistrement réussi' }));
                    broadcastEspStatus();
                } else if (device === 'esp32-standard') {
                    clients.espStandard = socket;
                    espStandardConnected = true;
                    console.log('✅ ESP32-Standard connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'Enregistrement réussi' }));
                    broadcastEspStatus();
                } else {
                    console.log(`Type de dispositif inconnu: ${device}`);
                    socket.send(JSON.stringify({ type: 'error', message: 'Type de dispositif inconnu' }));
                    socket.close(1000, 'Type de dispositif inconnu');
                }
            } else if (!socket.clientType) {
                console.log(`Message JSON reçu avant enregistrement (ID: ${clientId}): ${JSON.stringify(message)}`);
                socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis avant envoi de messages' }));
            } else if (message.type === 'alert' && (socket.clientType === 'esp32-cam' || socket.clientType === 'esp32-standard')) {
                console.log(`Alerte reçue de ${socket.clientType} (ID: ${clientId}): ${message.message}`);
                // Transférer à l'application Android
                if (clients.android && clients.android.readyState === WebSocket.OPEN) {
                    clients.android.send(JSON.stringify(message));
                    console.log(`Alerte transférée à Android (ID: ${clients.android.clientId})`);
                }
                // Envoyer commande pour allumer la lampe à ESP-Standard
                sendToEspStandard({ type: 'turn_on_light' });
            } else if (message.type === 'network_config' && socket.clientType === 'android') {
                console.log(`Commande network_config reçue de Android (ID: ${clientId}): ${JSON.stringify(message.params)}`);
                // Transférer à ESP32-CAM et ESP32-Standard
                if (clients.espCam && clients.espCam.readyState === WebSocket.OPEN) {
                    clients.espCam.send(JSON.stringify(message));
                    console.log(`Commande network_config envoyée à ESP-CAM (ID: ${clients.espCam.clientId})`);
                }
                if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
                    clients.espStandard.send(JSON.stringify(message));
                    console.log(`Commande network_config envoyée à ESP-Standard (ID: ${clients.espStandard.clientId})`);
                }
                // Confirmer à l'application Android
                socket.send(JSON.stringify({
                    type: 'command_response',
                    success: true,
                    message: 'network_config envoyé. CAM: ' + (clients.espCam ? 'Queue' : 'Non connecté') + ', STD: ' + (clients.espStandard ? 'Queue' : 'Non connecté')
                }));
            } else if (message.type === 'security_config' && socket.clientType === 'android') {
                console.log(`Commande security_config reçue de Android (ID: ${clientId}): ${JSON.stringify(message.params)}`);
                // Transférer à ESP32-CAM et ESP32-Standard
                if (clients.espCam && clients.espCam.readyState === WebSocket.OPEN) {
                    clients.espCam.send(JSON.stringify(message));
                    console.log(`Commande security_config envoyée à ESP-CAM (ID: ${clients.espCam.clientId})`);
                }
                if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
                    clients.espStandard.send(JSON.stringify(message));
                    console.log(`Commande security_config envoyée à ESP-Standard (ID: ${clients.espStandard.clientId})`);
                }
                // Confirmer à l'application Android
                socket.send(JSON.stringify({
                    type: 'command_response',
                    success: true,
                    message: 'security_config envoyé. CAM: ' + (clients.espCam ? 'Queue' : 'Non connecté') + ', STD: ' + (clients.espStandard ? 'Queue' : 'Non connecté')
                }));
            } else if (message.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
                console.log(`Pong envoyé à ${socket.clientType} (ID: ${clientId})`);
            } else {
                console.log(`Message non géré de ${socket.clientType} (ID: ${clientId}): ${JSON.stringify(message)}`);
                socket.send(JSON.stringify({ type: 'error', message: 'Type de message inconnu' }));
            }
        } catch (error) {
            console.error(`Erreur traitement message (ID: ${clientId}):`, error);
            socket.send(JSON.stringify({ type: 'error', message: 'Erreur serveur: ' + error.message }));
        }
    });

    socket.on('close', (code, reason) => {
        console.log(`Client déconnecté (ID: ${clientId}, Type: ${socket.clientType || 'Unknown'}, Code: ${code}, Raison: ${reason.toString()})`);
        if (socket.clientType === 'android') {
            clients.android = null;
        } else if (socket.clientType === 'esp32-cam') {
            clients.espCam = null;
            espCamConnected = false;
            broadcastEspStatus();
        } else if (socket.clientType === 'esp32-standard') {
            clients.espStandard = null;
            espStandardConnected = false;
            broadcastEspStatus();
        }
        clearTimeout(registrationTimeout);
    });

    socket.on('error', (error) => {
        console.error(`Erreur WebSocket (ID: ${clientId}):`, error);
    });
});

// Lancer le serveur
server.listen(PORT, () => {
    console.log(`🚀 Serveur actif sur port ${PORT}. Écoute HTTP et WS.`);
});
