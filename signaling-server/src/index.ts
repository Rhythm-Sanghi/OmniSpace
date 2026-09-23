import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

interface Client {
  socket: WebSocket;
  peerId: string;
  sessionToken: string;
  joinedAt: number;
}

interface Room {
  pin: string;
  clients: Map<string, Client>; // peerId -> Client
  lastActivityAt: number;
}

// Memory stores for rooms and rate limiting
const rooms = new Map<string, Room>(); // roomPin -> Room
const failedAttemptsByIp = new Map<string, { count: number; lockedUntil: number }>();
const failedAttemptsBySocket = new WeakMap<WebSocket, number>();
const connectionsByIp = new Map<string, number>();
const turnRequestsByIp = new Map<string, { count: number; windowStart: number }>();

const MAX_ROOMS = 5000;
const MAX_CLIENTS_PER_ROOM = 25;
const MAX_CONCURRENT_CONNECTIONS_PER_IP = 50;

// Dynamic port resolution with validation
const rawPort = process.env.PORT ? parseInt(process.env.PORT, 10) : NaN;
if (process.env.PORT && (isNaN(rawPort) || rawPort <= 0 || rawPort > 65535)) {
  console.error(`[Startup Error] Invalid PORT environment variable: "${process.env.PORT}". Must be 1-65535.`);
  process.exit(1);
}
const PORT = (!isNaN(rawPort) && rawPort > 0) ? rawPort : 3000;

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB backpressure limit
const MAX_MESSAGES_PER_SECOND = 120; // Sliding window message rate limit per peer

function safeSend(socket: WebSocket, data: string): boolean {
  if (socket.readyState === WebSocket.OPEN) {
    if (socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      console.warn('[WS Backpressure] Socket buffer exceeded limit. Closing slow connection.');
      try {
        socket.close(1008, 'Buffer overflow');
      } catch {
        // Socket already closed
      }
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch (e) {
      console.warn('[WS Send Error]', e);
      return false;
    }
  }
  return false;
}

// HTTP server for health checks, cloud liveness probes, metrics, and TURN credentials relay
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  
  // Liveness probes
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Metrics endpoint (restricted to local IP or valid bearer token)
  if (req.method === 'GET' && url.pathname === '/metrics') {
    const clientIp = getClientIp(req);
    const metricsToken = process.env.METRICS_TOKEN;
    const authHeader = req.headers['authorization'];
    const isAuthorized = isLocalIp(clientIp) || (metricsToken && authHeader === `Bearer ${metricsToken}`);

    if (!isAuthorized) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    let totalClients = 0;
    rooms.forEach((r) => {
      totalClients += r.clients.size;
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
    });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        rooms: rooms.size,
        totalClients,
        trackedIps: connectionsByIp.size,
        lockedOutIps: failedAttemptsByIp.size,
        turnRateLimitedIps: turnRequestsByIp.size,
        memory: process.memoryUsage(),
      })
    );
    return;
  }

  // Secure TURN credentials relay for WebRTC clients (rate-limited per IP)
  if (req.method === 'GET' && url.pathname === '/api/turn-credentials') {
    const clientIp = getClientIp(req);
    const now = Date.now();
    const rateWindow = turnRequestsByIp.get(clientIp);

    if (!rateWindow || now - rateWindow.windowStart > 60000) {
      turnRequestsByIp.set(clientIp, { count: 1, windowStart: now });
    } else {
      rateWindow.count++;
      if (rateWindow.count > 20) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Too many TURN credential requests' }));
        return;
      }
    }

    const meteredApiKey = process.env.METERED_TURN_API_KEY;
    const defaultStun = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    if (!meteredApiKey) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ iceServers: defaultStun }));
      return;
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 5000);

    fetch(`https://flash-speaker.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredApiKey)}`, {
      signal: abortController.signal,
    })
      .then((turnRes) => {
        clearTimeout(timeoutId);
        if (!turnRes.ok) {
          throw new Error(`Metered API returned status ${turnRes.status}`);
        }
        return turnRes.json();
      })
      .then((credentials) => {
        const iceServers = Array.isArray(credentials) && credentials.length > 0
          ? credentials
          : defaultStun;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ iceServers }));
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        console.warn('[TURN Relay] Failed to retrieve dynamic TURN credentials, falling back to STUN:', err.message);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ iceServers: defaultStun }));
      });
    return;
  }

  // Fallback for unmatched HTTP routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

server.listen(PORT, () => {
  console.log(`[Omni-Space Signaling] Server listening on port ${PORT}`);
});

// Process signal and unhandled error handlers for clean teardown
function gracefulShutdown(signal: string) {
  console.log(`[Omni-Space Signaling] Received ${signal}, gracefully closing...`);
  clearInterval(heartbeatTimer);
  clearInterval(cleanupTimer);
  wss.clients.forEach((client) => {
    safeSend(client, JSON.stringify({ type: 'error', payload: { message: 'Server shutting down' } }));
    try {
      client.close();
    } catch {
      // Socket already closed
    }
  });

  if (typeof (server as any).closeAllConnections === 'function') {
    (server as any).closeAllConnections();
  }

  const forceExitTimer = setTimeout(() => {
    console.warn('[Omni-Space Signaling] Forcefully exiting after shutdown timeout');
    process.exit(0);
  }, 10000);
  forceExitTimer.unref();

  server.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[Omni-Space Signaling] Fatal uncaughtException:', err);
  clearInterval(heartbeatTimer);
  clearInterval(cleanupTimer);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Omni-Space Signaling] Unhandled Promise Rejection at:', promise, 'reason:', reason);
});

// Helper to extract client IP honoring TRUST_PROXY
function getClientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      const clientIp = parts[0];
      if (clientIp) return clientIp;
    } else if (Array.isArray(forwarded) && forwarded.length > 0) {
      const first = forwarded[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

// Helper to validate connection origins against CSWSH
function isOriginAllowed(origin: string | undefined): boolean {
  const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV || process.env.NODE_ENV === 'test';
  if (!origin) {
    return isDev;
  }
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith('tauri://') || origin.startsWith('https://tauri.localhost')) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return true;
    }
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.length === 0 && isDev;
}

// Helper to determine if IP is local/dev
function isLocalIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Clean up stale rooms and expired IP lockout records every 1 minute
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const idleTimeout = 30 * 60 * 1000; // 30 minutes

  for (const [pin, room] of rooms.entries()) {
    if (now - room.lastActivityAt > idleTimeout) {
      console.log(`[Room Cleanup] Room ${pin} has been idle. Closing.`);
      room.clients.forEach((client) => {
        safeSend(client.socket, JSON.stringify({ type: 'error', payload: { message: 'Room idle timeout' } }));
        try {
          client.socket.close();
        } catch {
          // Socket already closed
        }
      });
      rooms.delete(pin);
    }
  }

  for (const [ip, lock] of failedAttemptsByIp.entries()) {
    if (now > lock.lockedUntil) {
      failedAttemptsByIp.delete(ip);
    }
  }

  for (const [ip, windowRecord] of turnRequestsByIp.entries()) {
    if (now - windowRecord.windowStart > 60000) {
      turnRequestsByIp.delete(ip);
    }
  }

  // Hard cap on rate-limiting map size: evict oldest records instead of global wipe
  if (failedAttemptsByIp.size > 5000) {
    const toDeleteCount = failedAttemptsByIp.size - 4000;
    let deleted = 0;
    for (const key of failedAttemptsByIp.keys()) {
      failedAttemptsByIp.delete(key);
      deleted++;
      if (deleted >= toDeleteCount) break;
    }
  }
}, 60000);

interface ExtWebSocket extends WebSocket {
  isAlive?: boolean;
  messageCount?: number;
  messageWindowStart?: number;
}

// Ping all connected clients every 30 seconds to terminate unresponsive zombie sockets
const HEARTBEAT_INTERVAL = 30000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    const extWs = ws as ExtWebSocket;
    if (extWs.isAlive === false) {
      console.log('[WS Heartbeat] Terminating inactive/zombie socket');
      try {
        extWs.terminate();
      } catch {
        // Socket already closed
      }
      return;
    }
    extWs.isAlive = false;
    try {
      extWs.ping();
    } catch {
      // Ignored
    }
  });
}, HEARTBEAT_INTERVAL);

wss.on('connection', (socket, req) => {
  const extSocket = socket as ExtWebSocket;
  extSocket.isAlive = true;
  extSocket.messageCount = 0;
  extSocket.messageWindowStart = Date.now();
  extSocket.on('pong', () => {
    extSocket.isAlive = true;
  });

  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    console.warn(`[WS Origin Reject] Blocked connection from unauthorized origin: ${origin}`);
    safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Origin not allowed' } }));
    socket.close(1008, 'Origin not allowed');
    return;
  }

  const rawIp = getClientIp(req);
  const isLocal = isLocalIp(rawIp);
  let currentRoomPin: string | null = null;
  let clientPeerId: string | null = null;

  // Track and limit active connections per IP
  const currentCount = connectionsByIp.get(rawIp) || 0;
  if (!isLocal && currentCount >= MAX_CONCURRENT_CONNECTIONS_PER_IP) {
    safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Too many concurrent connections from this IP' } }));
    socket.close();
    return;
  }
  connectionsByIp.set(rawIp, currentCount + 1);

  console.log(`[WS Connect] Connection established from ${rawIp} (Local: ${isLocal})`);

  socket.on('message', (data) => {
    try {
      const now = Date.now();
      if (!extSocket.messageWindowStart || now - extSocket.messageWindowStart > 1000) {
        extSocket.messageCount = 0;
        extSocket.messageWindowStart = now;
      }
      extSocket.messageCount = (extSocket.messageCount || 0) + 1;
      if (extSocket.messageCount > MAX_MESSAGES_PER_SECOND) {
        console.warn(`[WS Rate Limit] Peer exceeded message rate limit (${MAX_MESSAGES_PER_SECOND}/s). Closing.`);
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Message rate limit exceeded' } }));
        socket.close(1008, 'Rate limit exceeded');
        return;
      }

      let rawParsed: unknown;
      try {
        rawParsed = JSON.parse(data.toString());
      } catch {
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON payload' } }));
        return;
      }

      if (!rawParsed || typeof rawParsed !== 'object') {
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Payload must be an object' } }));
        return;
      }

      const message = rawParsed as {
        type?: unknown;
        senderPeerId?: unknown;
        targetPeerId?: unknown;
        payload?: Record<string, any>;
      };
      const { type, senderPeerId, targetPeerId, payload } = message;

      if (!type || typeof type !== 'string' || type.length > 64) {
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Invalid or missing message type' } }));
        return;
      }

      // Validate senderPeerId presence and type
      if (!senderPeerId || typeof senderPeerId !== 'string' || senderPeerId.trim().length === 0 || senderPeerId.length > 128) {
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Invalid or missing senderPeerId' } }));
        return;
      }

      // Prevent peer impersonation on active connection
      if (clientPeerId && senderPeerId !== clientPeerId) {
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'SenderPeerId spoofing detected' } }));
        return;
      }

      // 1. Gated join-room logic with rate limiting
      if (type === 'join-room') {
        const joined = handleJoinRoom(socket, rawIp, isLocal, senderPeerId, payload);
        if (joined) {
          currentRoomPin = joined.roomPin;
          clientPeerId = joined.peerId;
        }
        return;
      }

      // 2. Targeted SDP/ICE routing logic: reject if client has not joined a room
      if (!currentRoomPin || !clientPeerId) {
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Must join room first' } }));
        return;
      }

      handleRelayMessage(socket, currentRoomPin, clientPeerId, type, targetPeerId, payload);
    } catch (err) {
      console.error(`[Message Error] Failed to process socket message:`, err);
    }
  });

  socket.on('close', () => {
    handleSocketClose(socket, rawIp, currentRoomPin, clientPeerId);
  });
});

interface JoinRoomResult {
  roomPin: string;
  peerId: string;
}

function handleJoinRoom(
  socket: WebSocket,
  rawIp: string,
  isLocal: boolean,
  senderPeerId: string,
  payload?: Record<string, any>
): JoinRoomResult | null {
  const { roomPin } = payload || {};
  const now = Date.now();

  // Check rate limit locks
  if (!isLocal) {
    const lock = failedAttemptsByIp.get(rawIp);
    if (lock && lock.count >= 5 && now < lock.lockedUntil) {
      const waitTime = Math.ceil((lock.lockedUntil - now) / 1000);
      safeSend(socket, JSON.stringify({ type: 'error', payload: { message: `Too many failures. Locked out. Wait ${waitTime}s.` } }));
      socket.close();
      return null;
    }
  } else {
    const failures = failedAttemptsBySocket.get(socket) || 0;
    if (failures >= 5) {
      safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Local socket rate limit exceeded' } }));
      socket.close();
      return null;
    }
  }

  const recordFailure = () => {
    if (!isLocal) {
      const lock = failedAttemptsByIp.get(rawIp) || { count: 0, lockedUntil: 0 };
      lock.count++;
      lock.lockedUntil = now + 15 * 60 * 1000; // 15 mins block
      failedAttemptsByIp.set(rawIp, lock);
    } else {
      const failures = failedAttemptsBySocket.get(socket) || 0;
      failedAttemptsBySocket.set(socket, failures + 1);
    }
  };

  // Unified PIN validation: PIN must be a string containing exactly 6 numeric digits
  const isNumeric = typeof roomPin === 'string' && /^\d{6}$/.test(roomPin);
  if (!isNumeric) {
    recordFailure();
    safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'PIN must contain exactly 6 digits' } }));
    return null;
  }

  // Room capacity limits
  if (!rooms.has(roomPin) && rooms.size >= MAX_ROOMS) {
    safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Server room capacity exceeded' } }));
    return null;
  }

  // Setup room
  let room = rooms.get(roomPin);
  if (!room) {
    room = {
      pin: roomPin,
      clients: new Map(),
      lastActivityAt: Date.now(),
    };
    rooms.set(roomPin, room);
    console.log(`[Room Create] Room ${roomPin} created by ${senderPeerId}`);
  } else if (room.clients.size >= MAX_CLIENTS_PER_ROOM && !room.clients.has(senderPeerId)) {
    safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Room is full' } }));
    return null;
  }

  room.lastActivityAt = Date.now();

  // S-5: Session token verification to prevent peer impersonation & socket hijacking
  const clientToken = (payload && typeof payload.sessionToken === 'string') ? payload.sessionToken : null;
  const existingClient = room.clients.get(senderPeerId);

  if (existingClient) {
    // If an existing client is registered, require valid sessionToken to permit socket takeover
    if (existingClient.sessionToken && clientToken !== existingClient.sessionToken) {
      console.warn(`[Unauthorized Reconnect] Client ${senderPeerId} attempted takeover with invalid token in room ${roomPin}`);
      safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Unauthorized peer ID replacement' } }));
      return null;
    }
    console.log(`[Prune Stale] Authorized reconnect for ${senderPeerId} in room ${roomPin}. Closing old socket.`);
    try {
      existingClient.socket.close();
    } catch {
      // Already closed
    }
  }

  const assignedSessionToken = clientToken || crypto.randomUUID();

  // Add client to room
  room.clients.set(senderPeerId, {
    socket,
    peerId: senderPeerId,
    sessionToken: assignedSessionToken,
    joinedAt: Date.now(),
  });

  // 1. Send Room Roster to the joining peer along with its assigned sessionToken
  const peerList = Array.from(room.clients.keys());
  safeSend(
    socket,
    JSON.stringify({
      type: 'room-roster',
      senderPeerId: 'server',
      payload: { peers: peerList, sessionToken: assignedSessionToken },
    })
  );

  // 2. Broadcast peer-joined to all other clients in the room
  room.clients.forEach((client) => {
    if (client.peerId !== senderPeerId) {
      safeSend(
        client.socket,
        JSON.stringify({
          type: 'peer-joined',
          senderPeerId: 'server',
          payload: { peerId: senderPeerId },
        })
      );
    }
  });

  console.log(`[Room Join] Client ${senderPeerId} joined room ${roomPin}. Roster size: ${room.clients.size}`);
  return { roomPin, peerId: senderPeerId };
}

function handleRelayMessage(
  socket: WebSocket,
  currentRoomPin: string,
  clientPeerId: string,
  type: string,
  targetPeerId?: unknown,
  payload?: Record<string, any>
) {
  // Whitelist permitted relay message types to prevent spoofed internal signals
  const allowedRelayTypes = ['offer', 'answer', 'ice-candidate'];
  if (!allowedRelayTypes.includes(type)) {
    safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Unsupported relay message type' } }));
    return;
  }

  // Validate payload is a plain object and does not exceed size limit
  if (payload !== undefined) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Message payload must be a plain object' } }));
      return;
    }
    try {
      if (JSON.stringify(payload).length > 32768) {
        safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Message payload exceeds size limit (32KB)' } }));
        return;
      }
    } catch {
      safeSend(socket, JSON.stringify({ type: 'error', payload: { message: 'Failed to serialize payload' } }));
      return;
    }
  }

  const room = rooms.get(currentRoomPin);
  if (!room) return;

  room.lastActivityAt = Date.now();

  if (typeof targetPeerId === 'string') {
    const target = room.clients.get(targetPeerId);
    if (target && target.socket.readyState === WebSocket.OPEN) {
      safeSend(
        target.socket,
        JSON.stringify({
          type,
          senderPeerId: clientPeerId,
          payload,
        })
      );
    }
  }
}

function handleSocketClose(
  socket: WebSocket,
  rawIp: string,
  currentRoomPin: string | null,
  clientPeerId: string | null
) {
  console.log(`[WS Close] Socket connection closed for ${rawIp}`);

  // Decrement connection count
  const count = connectionsByIp.get(rawIp) || 1;
  if (count <= 1) {
    connectionsByIp.delete(rawIp);
  } else {
    connectionsByIp.set(rawIp, count - 1);
  }

  if (currentRoomPin && clientPeerId) {
    const room = rooms.get(currentRoomPin);
    if (room) {
      const client = room.clients.get(clientPeerId);
      // Ensure we only delete if the socket matches (so a reconnecting client doesn't delete itself)
      if (client && client.socket === socket) {
        room.clients.delete(clientPeerId);
        console.log(`[Peer Left] Client ${clientPeerId} removed from room ${currentRoomPin}. Roster size: ${room.clients.size}`);

        // Broadcast peer-left for fast-path cleanup
        room.clients.forEach((c) => {
          safeSend(
            c.socket,
            JSON.stringify({
              type: 'peer-left',
              senderPeerId: 'server',
              payload: { peerId: clientPeerId },
            })
          );
        });
      }

      if (room.clients.size === 0) {
        console.log(`[Room Empty] Room ${currentRoomPin} is empty. Removing room.`);
        rooms.delete(currentRoomPin);
      }
    }
  }
}

