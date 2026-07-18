// NEW: Import required libraries
const { WebSocketServer, WebSocket } = require('ws');
const { SocksProxyAgent } = require('socks-proxy-agent');

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

// Save this as: server.js
// Run with: node server.js

const SIGNALING_PORT = 8080;
const WEB_PORT = 9000;
const TOR_PROXY_HOST = '127.0.0.1';
const TOR_PROXY_PORT = 9050; // Or 9150 if using Tor Browser

// Store active WebSocket connections (clientId -> WebSocket)
const connections = new Map();

// NEW: Store outgoing proxy client connections (url -> WebSocket)
const proxyClients = new Map();

// ===
// THE FIX: Use 'socks5h://' to force DNS resolution through the proxy.
// ===
const torAgent = new SocksProxyAgent(`socks5h://${TOR_PROXY_HOST}:${TOR_PROXY_PORT}`);

// NEW: Helper function to generate client IDs
function generateClientId() {
    return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// === NEW: Refactored sendViaProxy ===
// This function now uses 'ws' and 'socks-proxy-agent',
// caches connections, and pushes responses back to the original client.
/**
 * @param {string} url - The target websocket URL (e.g., "ws://...")
 * @param {object} message - The message object to send
 * @param {string} originalSenderId - The ID of the client on *our* server
 */
function sendViaProxy(url, message, originalSenderId) {
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('ws://') && !cleanUrl.startsWith('wss://')) {
        cleanUrl = 'ws://' + cleanUrl;
    }

    return new Promise((resolve, reject) => {
        const sendMessage = (client) => {
            try {
                client.send(JSON.stringify(message));
                console.log(`Proxied message to ${cleanUrl}`);
                resolve(); // Resolves when the message is *sent*
            } catch (e) {
                reject(e);
            }
        };

        let proxyWs = proxyClients.get(cleanUrl);

        // 1. Reuse existing, open connection
        if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
            console.log(`Reusing existing proxy connection to ${cleanUrl}`);
            sendMessage(proxyWs);
            return;
        }

        // 2. Wait for connection in progress
        if (proxyWs && proxyWs.readyState === WebSocket.CONNECTING) {
            console.log(`Waiting for proxy connection to ${cleanUrl} to open...`);
            proxyWs.once('open', () => sendMessage(proxyWs));
            proxyWs.once('error', (err) => reject(err));
            return;
        }

        // 3. Create new connection
        console.log(`Creating new proxy connection to ${cleanUrl} via Tor...`);
        const newProxyWs = new WebSocket(cleanUrl, {
            agent: torAgent,  // This handles SOCKS *and* TLS for wss://
            timeout: 60000    // Long timeout for Tor
        });
        
        proxyClients.set(cleanUrl, newProxyWs); // Cache immediately

        newProxyWs.on('open', () => {
            console.log(`Proxy connection to ${cleanUrl} established.`);
            sendMessage(newProxyWs);
        });

        // *** THIS IS THE FIX FOR RESPONSES ***
        newProxyWs.on('message', (data) => {
            console.log(`Received proxy response from ${cleanUrl}`);
            try {
                // Find the *original client* who made the request
                const originalClientWs = connections.get(originalSenderId);
                
                if (originalClientWs && originalClientWs.readyState === WebSocket.OPEN) {
                    console.log(`Forwarding proxy response to client ${originalSenderId}`);
                    // Forward the message directly (no queue!)
                    originalClientWs.send(data.toString('utf8'));
                } else {
                    console.warn(`Original client ${originalSenderId} not found for proxy response.`);
                }
            } catch (e) {
                console.error('Failed to parse/forward proxy response:', e.message);
            }
        });

        newProxyWs.on('close', () => {
            console.log(`Proxy connection to ${cleanUrl} closed.`);
            proxyClients.delete(cleanUrl); // Remove from cache
        });

        newProxyWs.on('error', (err) => {
            console.error(`Proxy connection to ${cleanUrl} error:`, err.message);
            if (newProxyWs.readyState !== WebSocket.OPEN) {
                reject(err); // Fail the promise if connection failed
            }
            proxyClients.delete(cleanUrl); // Remove from cache
        });
    });
}

// === Web server (Unchanged) ===
const webServer = http.createServer((req, res) => {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Serve index.html
    if (req.method === 'GET' && req.url === '/') {
        const filePath = path.join(__dirname, 'index.html');
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                console.error('Error reading index.html:', err);
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Error: index.html not found. Please ensure index.html is in the same directory as this server file.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }
    
    // 404 for other routes
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

webServer.listen(WEB_PORT, () => {
    console.log(`Web server running on http://localhost:${WEB_PORT}`);
    
    // Auto-open browser
    const url = `http://localhost:${WEB_PORT}`;
    const start = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';
    
    exec(`${start} ${url}`, (err) => {
        if (err) {
            console.log('Could not auto-open browser. Please navigate to:', url);
        }
    });
});

// === NEW: Refactored WebSocket Signaling Server ===
const signalingServer = http.createServer();
const wss = new WebSocketServer({ server: signalingServer });

// NEW: Helper function to handle signaling (push, not poll)
function handleSignaling(senderId, parsedMessage) {
    const messageString = JSON.stringify(parsedMessage);

    if (parsedMessage.targetClientId) {
        // Direct message (push)
        const targetWs = connections.get(parsedMessage.targetClientId);
        
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            console.log(`Forwarding ${parsedMessage.type} from ${senderId} to ${parsedMessage.targetClientId}`);
            targetWs.send(messageString);
        } else {
            console.warn(`Target client ${parsedMessage.targetClientId} not found or connection not open.`);
        }
    } else {
        // Broadcast message (FIXED: removed localhost-only check)
        console.log(`Broadcasting ${parsedMessage.type} from ${senderId}`);
        let sentCount = 0;
        connections.forEach((conn, id) => {
            if (id !== senderId && conn.readyState === WebSocket.OPEN) {
                conn.send(messageString);
                sentCount++;
            }
        });
        console.log(`Broadcast ${parsedMessage.type} to ${sentCount} client(s)`);
    }
}

// NEW: Wrapper for proxy calls
function handleProxySend(ws, clientId, parsedMessage) {
    console.log('Processing proxy send request...');
    console.log('Proxy message details:', {
        url: parsedMessage.url,
        messageType: parsedMessage.message?.type,
        senderId: parsedMessage.message?.senderId
    });
    
    // Pass clientId as originalSenderId for response routing
    sendViaProxy(parsedMessage.url, parsedMessage.message, clientId)
        .then(() => {
            ws.send(JSON.stringify({ 
                type: 'proxy-response', 
                success: true 
            }));
        })
        .catch((error) => {
            ws.send(JSON.stringify({ 
                type: 'proxy-response', 
                success: false, 
                error: error.message 
            }));
        });
}

// NEW: Handle new connections using 'ws'
wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    connections.set(clientId, ws); // Store the actual WebSocket object
    console.log(`\n=== Client ${clientId} connected ===`);
    console.log(`Total active connections: ${connections.size}`);

    // Send the client their ID
    try {
        ws.send(JSON.stringify({ type: 'welcome', clientId: clientId }));
    } catch (e) {
        console.error("Failed to send welcome message:", e.message);
    }

    // Handle incoming messages
    ws.on('message', (messageBuffer) => {
        let parsedMessage;
        try {
            // 'ws' handles unmasking and frame reassembly automatically
            parsedMessage = JSON.parse(messageBuffer.toString('utf8'));
        } catch (e) {
            console.error(`Failed to parse JSON from ${clientId}:`, e.message);
            return;
        }

        console.log(`\n[${clientId}] Received: ${parsedMessage.type}`);
        
        // Add senderId for routing
        // Note: We use the server-assigned clientId, not one from the message
        parsedMessage.senderId = clientId;

        switch (parsedMessage.type) {
            case 'offer':
            case 'answer':
            case 'ice-candidate':
                handleSignaling(clientId, parsedMessage);
                break;
            
            case 'proxy-send':
                // The message *to be proxied* is in parsedMessage.message
                // We must ensure *that* message also has the senderId
                if (parsedMessage.message) {
                    parsedMessage.message.senderId = clientId;
                }
                handleProxySend(ws, clientId, parsedMessage);
                break;
            
            default:
                console.warn(`Unknown message type from ${clientId}: ${parsedMessage.type}`);
        }
    });

    // Handle client disconnection
    ws.on('close', () => {
        connections.delete(clientId);
        console.log(`\nClient ${clientId} disconnected`);
        console.log(`Remaining connections: ${connections.size}`);
    });

    // Handle socket errors
    ws.on('error', (error) => {
        console.error(`Socket error for ${clientId}:`, error.message);
        connections.delete(clientId); // Ensure cleanup on error
    });
});

// === Server Startup and Error Handling (Mostly Unchanged) ===
signalingServer.listen(SIGNALING_PORT, '127.0.0.1', () => {
    console.log(`\nSignaling server listening on 127.0.0.1:${SIGNALING_PORT}`);
    
    // Get local IP address (from original file)
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const iface of Object.values(interfaces)) {
        for (const alias of iface) {
            if (alias.family === 'IPv4' && !alias.internal) {
                addresses.push(alias.address);
            }
        }
    }
    
    if (addresses.length > 0) {
        console.log('\n╔═══════════════════════════════════════╗');
        console.log('║  Share these URLs with remote peers:    ║');
        console.log('╚═══════════════════════════════════════╝');
        addresses.forEach(addr => {
            console.log(`  ws://${addr}:${SIGNALING_PORT}`);
        });
        console.log('');
    }
});

// Handle server errors
webServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nError: Port ${WEB_PORT} is already in use.`);
        console.error('Please close the application using this port or change WEB_PORT in the code.\n');
    } else {
        console.error('Web server error:', err);
    }
    process.exit(1);
});

signalingServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nError: Port ${SIGNALING_PORT} is already in use.`);
        console.error('Please close the application using this port or change SIGNALING_PORT in the code.\n');
    } else {
        console.error('Signaling server error:', err);
    }
    process.exit(1);
});

console.log('\n╔═══════════════════════════════════════╗');
console.log('║  WebRTC P2P Video Chat Server Started   ║');
console.log('╚═══════════════════════════════════════╝');
console.log(`\n  Web Interface: http://localhost:${WEB_PORT}`);
console.log(`  Signaling Port: ${SIGNALING_PORT}`);
console.log('\n  Waiting for connections...\n');