import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { spawn } from 'child_process';
import path from 'path';

describe('Signaling Server Broker Integration', () => {
  let serverProcess: any;
  const serverUrl = 'ws://localhost:3000';
  const openSockets: WebSocket[] = [];

  const createSocket = (url: string): WebSocket => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    return ws;
  };

  afterEach(async () => {
    const toClose = [...openSockets];
    openSockets.length = 0;
    await Promise.all(
      toClose.map((ws) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          return new Promise<void>((resolve) => {
            ws.once('close', () => resolve());
            try {
              ws.close();
            } catch {
              resolve();
            }
            setTimeout(resolve, 500);
          });
        }
        return Promise.resolve();
      })
    );
  });

  beforeAll(async () => {
    // Start signaling server in a background process
    const indexPath = path.resolve(__dirname, '../src/index.ts');
    serverProcess = spawn('node', ['--import', 'tsx', indexPath], {
      env: { ...process.env, PORT: '3000' },
    });

    // Dynamically poll /health endpoint until server is responsive
    const start = Date.now();
    let isReady = false;
    while (Date.now() - start < 10000) {
      try {
        const res = await fetch('http://localhost:3000/health');
        if (res.ok) {
          isReady = true;
          break;
        }
      } catch {
        // Still booting, retry
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!isReady) {
      throw new Error('Signaling server failed to become healthy within 10 seconds');
    }
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it('coordinates room joins and targeted routing', async () => {
    const clientA = createSocket(serverUrl);
    const clientB = createSocket(serverUrl);

    // Setup helper to wait for socket open
    const openSocket = (ws: WebSocket) =>
      new Promise<void>((resolve) => {
        ws.on('open', resolve);
      });

    await Promise.all([openSocket(clientA), openSocket(clientB)]);

    const pin = '999999';

    // Client A joins
    clientA.send(
      JSON.stringify({
        type: 'join-room',
        senderPeerId: 'client-A',
        payload: { roomPin: pin },
      })
    );

    // Assert client A receives initial roster containing only A
    const rosterA = await new Promise<any>((resolve) => {
      clientA.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(rosterA.type).toBe('room-roster');
    expect(rosterA.payload.peers).toContain('client-A');

    // Register Client A listener for peer-joined before sending B join
    const joinedEventPromise = new Promise<any>((resolve) => {
      clientA.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    // Client B joins same room
    clientB.send(
      JSON.stringify({
        type: 'join-room',
        senderPeerId: 'client-B',
        payload: { roomPin: pin },
      })
    );

    // Assert client B roster contains A and B
    const rosterB = await new Promise<any>((resolve) => {
      clientB.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(rosterB.type).toBe('room-roster');
    expect(rosterB.payload.peers).toContain('client-A');
    expect(rosterB.payload.peers).toContain('client-B');

    // Assert Client A receives peer-joined broadcast for B
    const joinedEvent = await joinedEventPromise;
    expect(joinedEvent.type).toBe('peer-joined');
    expect(joinedEvent.payload.peerId).toBe('client-B');

    // Test targeted message routing from A to B
    clientA.send(
      JSON.stringify({
        type: 'offer',
        senderPeerId: 'client-A',
        targetPeerId: 'client-B',
        payload: { sdp: 'test-sdp-offer' },
      })
    );

    const receivedOffer = await new Promise<any>((resolve) => {
      clientB.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(receivedOffer.type).toBe('offer');
    expect(receivedOffer.senderPeerId).toBe('client-A');
    expect(receivedOffer.payload.sdp).toBe('test-sdp-offer');

    // Test Peer Left broadcast on B closing
    clientB.close();
    
    const leftEvent = await new Promise<any>((resolve) => {
      clientA.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(leftEvent.type).toBe('peer-left');
    expect(leftEvent.payload.peerId).toBe('client-B');

    clientA.close();
  });

  it('serves HTTP health check endpoints', async () => {
    const healthRes = await fetch('http://localhost:3000/health');
    expect(healthRes.status).toBe(200);
    const healthData = await healthRes.json();
    expect(healthData.status).toBe('ok');
    expect(typeof healthData.uptime).toBe('number');

    const rootRes = await fetch('http://localhost:3000/');
    expect(rootRes.status).toBe(200);
    const rootData = await rootRes.json();
    expect(rootData.status).toBe('ok');
  });

  it('rejects invalid message payloads with error responses', async () => {
    const ws = createSocket(serverUrl);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Send malformed non-JSON
    ws.send('not a valid json string');
    const err1 = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(err1.type).toBe('error');
    expect(err1.payload.message).toContain('Invalid JSON payload');

    // Send missing type
    ws.send(JSON.stringify({ senderPeerId: 'test-peer' }));
    const err2 = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(err2.type).toBe('error');
    expect(err2.payload.message).toContain('Invalid or missing message type');

    ws.close();
  });

  it('prevents senderPeerId spoofing after room join', async () => {
    const ws = createSocket(serverUrl);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        type: 'join-room',
        senderPeerId: 'legit-peer',
        payload: { roomPin: '123456' },
      })
    );

    await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    // Attempt to send an offer pretending to be a different sender
    ws.send(
      JSON.stringify({
        type: 'offer',
        senderPeerId: 'imposter-peer',
        targetPeerId: 'legit-peer',
        payload: { sdp: 'fake' },
      })
    );

    const spoofErr = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(spoofErr.type).toBe('error');
    expect(spoofErr.payload.message).toBe('SenderPeerId spoofing detected');

    ws.close();
  });

  it('assigns sessionToken and prevents unauthorized peer takeover', async () => {
    const ws1 = createSocket(serverUrl);
    await new Promise<void>((resolve) => ws1.on('open', resolve));

    ws1.send(
      JSON.stringify({
        type: 'join-room',
        senderPeerId: 'victim-peer',
        payload: { roomPin: '888888' },
      })
    );

    const roster = await new Promise<any>((resolve) => {
      ws1.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(roster.type).toBe('room-roster');
    const token = roster.payload.sessionToken;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);

    // Imposter attempts to join with victim-peer ID with wrong session token
    const ws2 = createSocket(serverUrl);
    await new Promise<void>((resolve) => ws2.on('open', resolve));

    ws2.send(
      JSON.stringify({
        type: 'join-room',
        senderPeerId: 'victim-peer',
        payload: { roomPin: '888888', sessionToken: 'wrong-token' },
      })
    );

    const takeoverErr = await new Promise<any>((resolve) => {
      ws2.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(takeoverErr.type).toBe('error');
    expect(takeoverErr.payload.message).toBe('Unauthorized peer ID replacement');

    ws1.close();
    ws2.close();
  });

  it('serves rate-limited /api/turn-credentials endpoint', async () => {
    const res = await fetch('http://localhost:3000/api/turn-credentials');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.iceServers)).toBe(true);
    expect(data.iceServers.length).toBeGreaterThan(0);
  });

  it('rejects invalid PIN format', async () => {
    const ws = createSocket(serverUrl);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        type: 'join-room',
        senderPeerId: 'invalid-pin-tester',
        payload: { roomPin: '123' }, // not 6 digits
      })
    );

    const err = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(err.type).toBe('error');
    expect(err.payload.message).toBe('PIN must contain exactly 6 digits');

    ws.close();
  });

  it('handles OPTIONS preflight on /api/turn-credentials', async () => {
    const res = await fetch('http://localhost:3000/api/turn-credentials', {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves diagnostic /metrics endpoint with health counters', async () => {
    const res = await fetch('http://localhost:3000/metrics');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(typeof data.rooms).toBe('number');
    expect(typeof data.totalClients).toBe('number');
    expect(typeof data.trackedIps).toBe('number');
  });
});

