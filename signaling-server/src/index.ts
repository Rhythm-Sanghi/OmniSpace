import { WebSocketServer, WebSocket } from 'ws';

interface Client {
  socket: WebSocket;
  peerId: string;
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

const PORT = 3000;
const wss = new WebSocketServer({ port: PORT });

console.log(`[Omni-Space Signaling] Server started on port ${PORT}`);

// Helper to determine if IP is local/dev
function isLocalIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('localhost');
}

// Clean up stale rooms every 1 minute
setInterval(() => {
  const now = Date.now();
  const idleTimeout = 30 * 60 * 1000; // 30 minutes

  for (const [pin, room] of rooms.entries()) {
    if (now - room.lastActivityAt > idleTimeout) {
      console.log(`[Room Cleanup] Room ${pin} has been idle. Closing.`);
      room.clients.forEach((client) => {
        client.socket.send(JSON.stringify({ type: 'error', payload: { message: 'Room idle timeout' } }));
        client.socket.close();
      });
      rooms.delete(pin);
    }
  }
}, 60000);

wss.on('connection', (socket, req) => {
  const rawIp = req.socket.remoteAddress || 'unknown';
  const isLocal = isLocalIp(rawIp);
  let currentRoomPin: string | null = null;
  let clientPeerId: string | null = null;

  console.log(`[WS Connect] Connection established from ${rawIp} (Local: ${isLocal})`);

  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { type, senderPeerId, targetPeerId, payload } = message;

      // 1. Gated join-room logic with rate limiting
      if (type === 'join-room') {
        const { roomPin } = payload;

        if (!roomPin || typeof roomPin !== 'string' || roomPin.length !== 6) {
          socket.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid 6-digit PIN' } }));
          return;
        }

        // Check locks
        const now = Date.now();
        if (!isLocal) {
          const lock = failedAttemptsByIp.get(rawIp);
          if (lock && lock.count >= 5 && now < lock.lockedUntil) {
            const waitTime = Math.ceil((lock.lockedUntil - now) / 1000);
            socket.send(JSON.stringify({ type: 'error', payload: { message: `Too many failures. Locked out. Wait ${waitTime}s.` } }));
            socket.close();
            return;
          }
        } else {
          const failures = failedAttemptsBySocket.get(socket) || 0;
          if (failures >= 5) {
            socket.send(JSON.stringify({ type: 'error', payload: { message: 'Local socket rate limit exceeded' } }));
            socket.close();
            return;
          }
        }

        // Validate PIN (dummy validation: PIN must be numbers only for sanity check)
        const isNumeric = /^\d{6}$/.test(roomPin);
        if (!isNumeric) {
          // Track failure
          if (!isLocal) {
            const lock = failedAttemptsByIp.get(rawIp) || { count: 0, lockedUntil: 0 };
            lock.count++;
            lock.lockedUntil = now + 15 * 60 * 1000; // 15 mins block
            failedAttemptsByIp.set(rawIp, lock);
          } else {
            const failures = failedAttemptsBySocket.get(socket) || 0;
            failedAttemptsBySocket.set(socket, failures + 1);
          }
          socket.send(JSON.stringify({ type: 'error', payload: { message: 'PIN must contain exactly 6 digits' } }));
          return;
        }

        // Valid PIN code - join room
        currentRoomPin = roomPin;
        clientPeerId = senderPeerId;

        // Clear failures on successful join
        if (!isLocal) {
          failedAttemptsByIp.delete(rawIp);
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
        }

        room.lastActivityAt = Date.now();

        // If client already exists in room with same peerId (e.g. reconnecting), dispose previous socket
        const existingClient = room.clients.get(senderPeerId);
        if (existingClient) {
          console.log(`[Prune Stale] Duplicate client ${senderPeerId} detected in room ${roomPin}. Closing old socket.`);
          existingClient.socket.close();
        }

        // Add client to room
        room.clients.set(senderPeerId, {
          socket,
          peerId: senderPeerId,
          joinedAt: Date.now(),
        });

        // 1. Send Room Roster to the joining peer (list of all active peer IDs currently in room)
        const peerList = Array.from(room.clients.keys());
        socket.send(
          JSON.stringify({
            type: 'room-roster',
            senderPeerId: 'server',
            payload: { peers: peerList },
          })
        );

        // 2. Broadcast peer-joined to all other clients in the room
        room.clients.forEach((client) => {
          if (client.peerId !== senderPeerId) {
            client.socket.send(
              JSON.stringify({
                type: 'peer-joined',
                senderPeerId: 'server',
                payload: { peerId: senderPeerId },
              })
            );
          }
        });

        console.log(`[Room Join] Client ${senderPeerId} joined room ${roomPin}. Roster size: ${room.clients.size}`);
        return;
      }

      // 2. Targeted SDP/ICE routing logic
      if (currentRoomPin && clientPeerId) {
        const room = rooms.get(currentRoomPin);
        if (!room) return;

        room.lastActivityAt = Date.now();

        if (targetPeerId) {
          const target = room.clients.get(targetPeerId);
          if (target && target.socket.readyState === WebSocket.OPEN) {
            target.socket.send(
              JSON.stringify({
                type,
                senderPeerId: clientPeerId,
                payload,
              })
            );
          }
        }
      }
    } catch (err) {
      console.error(`[Message Error] Failed to process socket message:`, err);
    }
  });

  socket.on('close', () => {
    console.log(`[WS Close] Socket connection closed for ${rawIp}`);

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
            c.socket.send(
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
  });
});
