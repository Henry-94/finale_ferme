const https = require('https');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// PORT fourni par Render.com (interne)
const PORT = process.env.PORT || 10000;

// Créer un serveur HTTPS (Render injecte les certificats TLS automatiquement)
const server = https.createServer({
    // Pas besoin de key/cert : Render les gère via SNI
}, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket sécurisé (WSS) actif sur finale-ferme.onrender.com\n');
});

// Créer le serveur WebSocket sécurisé (WSS)
const wss = new WebSocket.Server({ server });

// === STOCKAGE CLIENTS ===
const clients = {
    android: null,
    espCam: null,
    espStandard: null
};

const photoQueue = [];
let espCamConnected = false;
let espStandardConnected = false;

// === FONCTIONS UTILITAIRES ===
function broadcastEspStatus() {
    if (clients.android && clients.android.readyState === WebSocket.OPEN) {
        const statusMessage = {
            type: 'esp_status',
            espCam: espCamConnected,
            espStandard: espStandardConnected,
            connected: espCamConnected
        };
        clients.android.send(JSON.stringify(statusMessage));
        console.log(`[Android] Status ESP envoyé: CAM=${espCamConnected}, STD=${espStandardConnected}`);
    }
}

function sendToEspStandard(message) {
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(JSON.stringify(message));
        console.log(`[ESP-Standard] Commande envoyée: ${JSON.stringify(message)}`);
    }
}

// === GESTION DES CONNEXIONS ===
wss.on('connection', (socket, req) => {
    const clientId = uuidv4();
    socket.clientId = clientId;
    socket.clientType = null;
    const clientIp = req.socket.remoteAddress || 'inconnu';
    const clientPort = req.socket.remotePort || 0;

    console.log(`Connexion entrante: ${clientIp}:${clientPort} (ID: ${clientId})`);

    // Timeout d'enregistrement
    const registrationTimeout = setTimeout(() => {
        if (!socket.clientType) {
            console.log(`[Timeout] Client ${clientId} non enregistré → déconnexion`);
            socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis dans les 45s' }));
            socket.close(1000, 'Timeout enregistrement');
        }
    }, 45000);

    socket.on('message', (data) => {
        try {
            let message;
            let isBinary = Buffer.isBuffer(data);

            // === GESTION DES MESSAGES BINAIRES (PHOTOS) ===
            if (isBinary) {
                const textData = data.toString('utf8');
                try {
                    message = JSON.parse(textData);
                    console.log(`[JSON via binaire] ${socket.clientType || 'Inconnu'} (${clientId}): ${textData}`);
                } catch (e) {
                    // Ce n'est pas du JSON → c'est une photo
                    if (socket.clientType === 'esp32-cam') {
                        console.log(`Photo reçue (${data.length} bytes) de ESP32-CAM (${clientId})`);

                        if (clients.android && clients.android.readyState === WebSocket.OPEN) {
                            clients.android.send(data); // Envoi direct binaire
                            console.log(`Photo transférée à Android`);
                        } else {
                            photoQueue.push(data);
                            console.log(`Android hors ligne → photo en file (queue: ${photoQueue.length})`);
                        }

                        sendToEspStandard({ type: 'turn_on_light' });
                        return;
                    } else {
                        console.log(`[Erreur] Données binaires reçues avant enregistrement`);
                        socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis avant photo' }));
                        return;
                    }
                }
            } else {
                // Message texte → JSON
                message = JSON.parse(data.toString());
                console.log(`[JSON] ${socket.clientType || 'Inconnu'} (${clientId}): ${JSON.stringify(message)}`);
            }

            // === TRAITEMENT DES MESSAGES JSON ===
            if (message.type === 'register') {
                clearTimeout(registrationTimeout);
                const device = message.device;

                if (device === 'android') {
                    clients.android = socket;
                    socket.clientType = 'android';
                    console.log('Android connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();
                    while (photoQueue.length > 0) {
                        const photo = photoQueue.shift();
                        socket.send(photo);
                        console.log(`Photo en attente envoyée à Android`);
                    }
                } else if (device === 'esp32-cam') {
                    clients.espCam = socket;
                    socket.clientType = 'esp32-cam';
                    espCamConnected = true;
                    console.log('ESP32-CAM connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();
                } else if (device === 'esp32-standard') {
                    clients.espStandard = socket;
                    socket.clientType = 'esp32-standard';
                    espStandardConnected = true;
                    console.log('ESP32-Standard connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();
                } else {
                    socket.send(JSON.stringify({ type: 'error', message: 'Device inconnu' }));
                    socket.close(1000, 'Device invalide');
                }

            } else if (!socket.clientType) {
                socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis' }));
            }

            // === COMMANDES ===
            else if (message.type === 'alert' && ['esp32-cam', 'esp32-standard'].includes(socket.clientType)) {
                if (clients.android) {
                    clients.android.send(JSON.stringify(message));
                    console.log(`Alerte transférée à Android: ${message.message}`);
                }
                sendToEspStandard({ type: 'turn_on_light' });
            }

            else if (message.type === 'network_config' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                if (clients.espCam) clients.espCam.send(msg);
                if (clients.espStandard) clients.espStandard.send(msg);
                socket.send(JSON.stringify({
                    type: 'command_response',
                    success: true,
                    message: `Config réseau envoyée`
                }));
            }

            else if (message.type === 'security_config' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                if (clients.espCam) clients.espCam.send(msg);
                if (clients.espStandard) clients.espStandard.send(msg);
                socket.send(JSON.stringify({
                    type: 'command_response',
                    success: true,
                    message: `Sécurité mise à jour`
                }));
            }

            else if (message.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
            }

            else {
                socket.send(JSON.stringify({ type: 'error', message: 'Commande inconnue' }));
            }

        } catch (error) {
            console.error(`[Erreur message] ${clientId}:`, error.message);
            socket.send(JSON.stringify({ type: 'error', message: 'Erreur serveur' }));
        }
    });

    socket.on('close', (code, reason) => {
        console.log(`Déconnexion: ${socket.clientType || 'Inconnu'} (${clientId}), code=${code}`);
        if (socket.clientType === 'android') clients.android = null;
        else if (socket.clientType === 'esp32-cam') { clients.espCam = null; espCamConnected = false; broadcastEspStatus(); }
        else if (socket.clientType === 'esp32-standard') { clients.espStandard = null; espStandardConnected = false; broadcastEspStatus(); }
        clearTimeout(registrationTimeout);
    });

    socket.on('error', (err) => {
        console.error(`[Erreur WS] ${clientId}:`, err.message);
    });
});

// === DÉMARRAGE SERVEUR ===
server.listen(PORT, () => {
    console.log(`SERVEUR WSS ACTIF`);
    console.log(`→ URL: wss://finale-ferme.onrender.com`);
    console.log(`→ Port interne: ${PORT}`);
    console.log(`→ Protocole: WSS (TLS géré par Render)`);
});
