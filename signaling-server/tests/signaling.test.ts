import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import path from 'path';

describe('Signaling Server Broker Integration', () => {
  let serverProcess: any;
  const serverUrl = 'ws://localhost:3000';

  beforeAll(async () => {
    // Start signaling server in a background process
    const indexPath = path.resolve(__dirname, '../src/index.ts');
    serverProcess = spawn('node', ['--import', 'tsx', indexPath], {
      env: { ...process.env, PORT: '3000' },
    });

    // Wait 3.0 seconds for server to start
    await new Promise((resolve) => setTimeout(resolve, 3000));
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it('coordinates room joins and targeted routing', async () => {
    const clientA = new WebSocket(serverUrl);
    const clientB = new WebSocket(serverUrl);

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
    const joinedEvent = await new Promise<any>((resolve) => {
      clientA.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
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
});
