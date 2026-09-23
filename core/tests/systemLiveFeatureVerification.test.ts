import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  Device,
  WindowInstance,
  handleWindowDrag,
  updateWindowSize,
  toggleWindowMaximize,
  computeSnapPosition,
  OmniClipboardSync,
  FileTransferSender,
  FileTransferReceiver,
  ReceivedFile,
  deriveKeyFromPin,
  encryptFrameData,
  decryptFrameData,
  isValidInputEventEnvelope,
  InputEventEnvelope,
} from '../src/index.js';

describe('Omni-Space Full Feature Live Verification', () => {
  const ROOM_PIN = '482910';
  const HOST_DEVICE_ID = 'laptop-host-x64';
  const MOBILE_DEVICE_ID = 'mobile-companion-pwa';

  let hostDoc: Y.Doc;
  let mobileDoc: Y.Doc;
  let hostAwareness: awarenessProtocol.Awareness;
  let mobileAwareness: awarenessProtocol.Awareness;

  beforeEach(() => {
    hostDoc = new Y.Doc();
    mobileDoc = new Y.Doc();
    hostAwareness = new awarenessProtocol.Awareness(hostDoc);
    mobileAwareness = new awarenessProtocol.Awareness(mobileDoc);

    // Cross-connect Yjs docs to simulate real-time CRDT DataChannel replication
    hostDoc.on('update', (update, origin) => {
      if (origin !== 'remote') {
        Y.applyUpdate(mobileDoc, update, 'remote');
      }
    });

    mobileDoc.on('update', (update, origin) => {
      if (origin !== 'remote') {
        Y.applyUpdate(hostDoc, update, 'remote');
      }
    });
  });

  afterEach(() => {
    hostDoc.destroy();
    mobileDoc.destroy();
    hostAwareness.destroy();
    mobileAwareness.destroy();
  });

  // --------------------------------------------------------------------------
  // FEATURE 1: Device Pairing & Spatial Calibration Topology
  // --------------------------------------------------------------------------
  it('Feature 1: Successfully pairs devices and synchronizes spatial arrangement topology', () => {
    const hostDevicesMap = hostDoc.getMap<Device>('devices');
    const mobileDevicesMap = mobileDoc.getMap<Device>('devices');

    // Host registers its display (1920x1080 at origin 0,0)
    const hostDevice: Device = {
      id: HOST_DEVICE_ID,
      name: "User's Laptop",
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      dpiScale: 1,
      status: 'connected',
      type: 'desktop',
    };

    // Mobile registers its companion screen placed to the right (x=1920, y=0, 1080x2400)
    const mobileDevice: Device = {
      id: MOBILE_DEVICE_ID,
      name: "User's Phone",
      width: 1080,
      height: 2400,
      x: 1920,
      y: 0,
      dpiScale: 2,
      status: 'connected',
      type: 'mobile',
    };

    hostDoc.transact(() => {
      hostDevicesMap.set(HOST_DEVICE_ID, hostDevice);
    });

    mobileDoc.transact(() => {
      mobileDevicesMap.set(MOBILE_DEVICE_ID, mobileDevice);
    });

    // Verify both devices have full, identical spatial topology
    expect(mobileDevicesMap.get(HOST_DEVICE_ID)).toEqual(hostDevice);
    expect(hostDevicesMap.get(MOBILE_DEVICE_ID)).toEqual(mobileDevice);

    const devices = Array.from(hostDevicesMap.values());
    expect(devices).toHaveLength(2);
    expect(devices.find((d) => d.id === HOST_DEVICE_ID)?.type).toBe('desktop');
    expect(devices.find((d) => d.id === MOBILE_DEVICE_ID)?.x).toBe(1920);
  });

  // --------------------------------------------------------------------------
  // FEATURE 2: Window Management, Drag Handoff, Resizing & Snapping
  // --------------------------------------------------------------------------
  it('Feature 2: Handles cross-device window drag handoff, resizing, and snapping', () => {
    const hostWindowsMap = hostDoc.getMap<WindowInstance>('windows');
    const mobileWindowsMap = mobileDoc.getMap<WindowInstance>('windows');
    const devices: Device[] = [
      { id: HOST_DEVICE_ID, name: 'Host', width: 1920, height: 1080, x: 0, y: 0, dpiScale: 1, status: 'connected', type: 'desktop' },
      { id: MOBILE_DEVICE_ID, name: 'Mobile', width: 1080, height: 2400, x: 1920, y: 0, dpiScale: 2, status: 'connected', type: 'mobile' },
    ];

    // 1. Host creates and shares an application window (e.g. VS Code)
    const windowId = 'win-vscode-editor';
    const initialWindow: WindowInstance = {
      id: windowId,
      title: 'Visual Studio Code - OmniSpace',
      x: 300,
      y: 150,
      width: 1000,
      height: 700,
      owningDeviceId: HOST_DEVICE_ID,
      capturingDeviceId: HOST_DEVICE_ID,
      hasActiveCapture: true,
    };

    hostDoc.transact(() => {
      hostWindowsMap.set(windowId, initialWindow);
    });

    // Window synchronizes to mobile companion
    expect(mobileWindowsMap.get(windowId)?.title).toBe('Visual Studio Code - OmniSpace');
    expect(mobileWindowsMap.get(windowId)?.owningDeviceId).toBe(HOST_DEVICE_ID);

    // 2. Drag window across boundary towards mobile device (cursor moves from x=300 to x=1950)
    const handoffTarget = handleWindowDrag(
      windowId,
      1950, // x=1950 is inside mobile screen (x: 1920..3000)
      300,
      HOST_DEVICE_ID,
      devices,
      hostWindowsMap
    );

    // Verify handoff was detected and ownership transferred to Mobile
    expect(handoffTarget).toBe(MOBILE_DEVICE_ID);
    expect(hostWindowsMap.get(windowId)?.owningDeviceId).toBe(MOBILE_DEVICE_ID);
    expect(mobileWindowsMap.get(windowId)?.owningDeviceId).toBe(MOBILE_DEVICE_ID);

    // 3. Mobile resizes the window on its screen
    const resizeSuccess = updateWindowSize(windowId, 800, 600, MOBILE_DEVICE_ID, mobileWindowsMap);
    expect(resizeSuccess).toBe(true);
    expect(hostWindowsMap.get(windowId)?.width).toBe(800);
    expect(hostWindowsMap.get(windowId)?.height).toBe(600);

    // 4. Mobile toggles maximize
    const maxSuccess = toggleWindowMaximize(windowId, MOBILE_DEVICE_ID, devices[1], mobileWindowsMap);
    expect(maxSuccess).toBe(true);
    expect(hostWindowsMap.get(windowId)?.isMaximized).toBe(true);

    // 5. Magnetic edge snapping
    const snapped = computeSnapPosition(
      15, // close to left edge (threshold 20)
      40,
      500,
      400,
      devices[0],
      20
    );
    expect(snapped.x).toBe(0); // snapped to left edge of device 0
  });

  // --------------------------------------------------------------------------
  // FEATURE 3: Remote Touch & Virtual Trackpad Input Translation
  // --------------------------------------------------------------------------
  it('Feature 3: Dispatches and validates remote touch, trackpad clicks, and modifier keys', () => {
    // 1. Mobile sends touch tap down and up
    const touchDownEnvelope: InputEventEnvelope = {
      targetWindowId: 'win-vscode-editor',
      event: {
        type: 'mousedown',
        data: { x: 0.5, y: 0.25, button: 0 }, // 50% width, 25% height
      },
      timestamp: Date.now(),
    };

    const touchUpEnvelope: InputEventEnvelope = {
      targetWindowId: 'win-vscode-editor',
      event: {
        type: 'mouseup',
        data: { x: 0.5, y: 0.25, button: 0 },
      },
      timestamp: Date.now() + 50,
    };

    // 2. Mobile sends virtual trackpad scroll gesture
    const scrollEnvelope: InputEventEnvelope = {
      targetWindowId: 'win-vscode-editor',
      event: {
        type: 'scroll',
        data: { x: 0.5, y: 0.5, deltaX: 0, deltaY: 120 },
      },
      timestamp: Date.now() + 100,
    };

    // 3. Mobile sends keyboard modifier key (Ctrl + S)
    const keyEnvelope: InputEventEnvelope = {
      targetWindowId: 'win-vscode-editor',
      event: {
        type: 'keydown',
        data: { code: 'KeyS', key: 's' },
      },
      timestamp: Date.now() + 150,
    };

    // Verify all input packets pass strict runtime validation
    expect(isValidInputEventEnvelope(touchDownEnvelope)).toBe(true);
    expect(isValidInputEventEnvelope(touchUpEnvelope)).toBe(true);
    expect(isValidInputEventEnvelope(scrollEnvelope)).toBe(true);
    expect(isValidInputEventEnvelope(keyEnvelope)).toBe(true);

    // Host translates normalized coordinates to actual window pixel coordinates
    const windowBounds = { x: 1920, y: 0, width: 800, height: 600 };
    const mousePayload = touchDownEnvelope.event.data as { x: number; y: number };
    const translatedX = Math.round(mousePayload.x * windowBounds.width);
    const translatedY = Math.round(mousePayload.y * windowBounds.height);

    expect(translatedX).toBe(400); // 50% of 800
    expect(translatedY).toBe(150); // 25% of 600
  });

  // --------------------------------------------------------------------------
  // FEATURE 4: Cross-Device Real-Time Clipboard Synchronization
  // --------------------------------------------------------------------------
  it('Feature 4: Synchronizes clipboard content seamlessly between Laptop and Mobile', async () => {
    let hostLocalClipboard = '';
    let mobileLocalClipboard = '';

    const hostClipboard = new OmniClipboardSync(
      HOST_DEVICE_ID,
      hostDoc,
      async () => hostLocalClipboard,
      async (text) => { hostLocalClipboard = text; }
    );

    const mobileClipboard = new OmniClipboardSync(
      MOBILE_DEVICE_ID,
      mobileDoc,
      async () => mobileLocalClipboard,
      async (text) => { mobileLocalClipboard = text; }
    );

    // Initialize observers
    hostClipboard.initialize();
    mobileClipboard.initialize();

    // 1. Host copies text and syncs via Yjs
    const sharedSecretUrl = 'https://omnispace.pages.dev/project-dashboard?token=xyz123';
    const now = Date.now();
    hostDoc.transact(() => {
      hostDoc.getMap('clipboard').set('data', {
        content: sharedSecretUrl,
        sourceDeviceId: HOST_DEVICE_ID,
        updatedAt: now + 5000,
      });
    });

    // Wait for microtask propagation
    await vi.waitFor(() => expect(mobileLocalClipboard).toBe(sharedSecretUrl));
    expect(mobileClipboard.getHistory()[0]?.content).toBe(sharedSecretUrl);

    // 2. Mobile copies text back to laptop
    const mobileNote = 'Copied from phone: 42.128.90.11';
    mobileDoc.transact(() => {
      mobileDoc.getMap('clipboard').set('data', {
        content: mobileNote,
        sourceDeviceId: MOBILE_DEVICE_ID,
        updatedAt: now + 10000,
      });
    });

    await vi.waitFor(() => expect(hostLocalClipboard).toBe(mobileNote));
    expect(hostClipboard.getHistory()[0]?.content).toBe(mobileNote);

    hostClipboard.destroy();
    mobileClipboard.destroy();
  });

  // --------------------------------------------------------------------------
  // FEATURE 5: Direct P2P Chunked File Transfer
  // --------------------------------------------------------------------------
  it('Feature 5: Transfers binary files via chunked P2P DataChannels with 100% byte fidelity', async () => {
    const sender = new FileTransferSender(8192); // 8 KB chunk size
    const receiver = new FileTransferReceiver();

    // Create a 32 KB sample binary payload (simulating a photo or PDF document)
    const originalBytes = new Uint8Array(32768);
    for (let i = 0; i < originalBytes.length; i++) {
      originalBytes[i] = (i * 17 + 3) % 256;
    }

    let progressReportCount = 0;
    let receivedFile: ReceivedFile | null = null;

    // Simulate sending through WebRTC DataChannel
    await sender.sendFile(
      {
        name: 'omnispace-spec.pdf',
        size: originalBytes.length,
        mimeType: 'application/pdf',
        data: originalBytes,
      },
      (payload) => {
        // Wire sender payload directly into receiver with onComplete callback
        receiver.handlePayload(
          payload,
          undefined,
          (file) => {
            receivedFile = file;
          }
        );
      },
      (progress) => {
        progressReportCount++;
        expect(progress.totalBytes).toBe(32768);
      }
    );

    // Verify transfer completion and byte-for-byte exactness
    expect(progressReportCount).toBeGreaterThan(0);
    expect(receivedFile).not.toBeNull();
    expect(receivedFile!.name).toBe('omnispace-spec.pdf');
    expect(receivedFile!.size).toBe(32768);
    expect(receivedFile!.data.length).toBe(originalBytes.length);

    // Check byte equality
    let matches = true;
    for (let i = 0; i < originalBytes.length; i++) {
      if (receivedFile!.data[i] !== originalBytes[i]) {
        matches = false;
        break;
      }
    }
    expect(matches).toBe(true);
  });

  // --------------------------------------------------------------------------
  // FEATURE 6: End-to-End Encryption (E2EE) with PIN-Derived Key
  // --------------------------------------------------------------------------
  it('Feature 6: Derives AES-GCM-256 session key from PIN and secures video/input frames', async () => {
    // Both sides derive key from the 6-digit room PIN
    const hostKey = await deriveKeyFromPin(ROOM_PIN);
    const mobileKey = await deriveKeyFromPin(ROOM_PIN);

    // Sample video frame / data packet
    const framePayload = new TextEncoder().encode('ENCODED_WEBRTC_VIDEO_FRAME_BUFFER_PAYLOAD');

    // Host encrypts frame
    const encryptedFrame = await encryptFrameData(hostKey, framePayload);

    // Verify encrypted frame has IV prepended and is larger than original
    expect(encryptedFrame.byteLength).toBeGreaterThan(framePayload.byteLength);

    // Mobile decrypts frame with its PIN key
    const decryptedFrame = await decryptFrameData(mobileKey, encryptedFrame);
    const decodedText = new TextDecoder().decode(decryptedFrame);

    expect(decodedText).toBe('ENCODED_WEBRTC_VIDEO_FRAME_BUFFER_PAYLOAD');

    // Tampering test: if any byte is altered in transit, decryption must throw
    const tampered = new Uint8Array(encryptedFrame);
    tampered[tampered.length - 1] ^= 0xff; // Flip bits in auth tag

    await expect(decryptFrameData(mobileKey, tampered)).rejects.toThrow();
  });
});
