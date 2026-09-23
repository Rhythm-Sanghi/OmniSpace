import { describe, it, expect } from 'vitest';
import {
  deriveKeyFromPin,
  encryptFrameData,
  decryptFrameData,
  createEncryptionTransform,
  createDecryptionTransform,
} from '../src/index.js';

describe('WebRTC E2EE (End-to-End Encryption)', () => {
  it('derives symmetric AES-GCM CryptoKey from room PIN', async () => {
    const key = await deriveKeyFromPin('123456');
    expect(key).toBeDefined();
    expect(key.algorithm.name).toBe('AES-GCM');
    expect((key.algorithm as any).length).toBe(256);
  });

  it('encrypts and decrypts frame data payload with full round-trip fidelity', async () => {
    const key = await deriveKeyFromPin('omni-pin-789');

    const originalData = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const encrypted = await encryptFrameData(key, originalData);

    // Encrypted data should be longer by IV (12 bytes) + AES-GCM tag (16 bytes) = 28 bytes
    expect(encrypted.byteLength).toBe(originalData.byteLength + 28);
    expect(encrypted).not.toEqual(originalData);

    const decrypted = await decryptFrameData(key, encrypted);
    expect(decrypted).toEqual(originalData);
  });

  it('fails decryption when ciphertext is tampered with', async () => {
    const key = await deriveKeyFromPin('secure-pin');
    const originalData = new Uint8Array([1, 2, 3, 4, 5]);
    const encrypted = await encryptFrameData(key, originalData);

    // Tamper with the last byte of ciphertext/tag
    encrypted[encrypted.length - 1] ^= 0xff;

    await expect(decryptFrameData(key, encrypted)).rejects.toThrow();
  });

  it('fails decryption when ciphertext is truncated below minimum length', async () => {
    const key = await deriveKeyFromPin('secure-pin');
    const tooShort = new Uint8Array(10); // Minimum is 12 (IV) + 16 (Tag) = 28 bytes

    await expect(decryptFrameData(key, tooShort)).rejects.toThrow(
      'Encrypted payload is too short'
    );
  });

  it('pipes frames through encryption and decryption transform streams', async () => {
    const key = await deriveKeyFromPin('stream-pin-999');

    const encryptTransform = createEncryptionTransform(key);
    const decryptTransform = createDecryptionTransform(key);

    const sampleBuffer = new Uint8Array([7, 14, 21, 28, 35, 42]).buffer;
    const inputFrame = { data: sampleBuffer };

    // Encrypt step
    const writer = encryptTransform.writable.getWriter();
    const reader = encryptTransform.readable.getReader();

    writer.write(inputFrame);
    writer.close();

    const { value: encryptedFrame } = await reader.read();
    expect(encryptedFrame).toBeDefined();
    expect(encryptedFrame.data.byteLength).toBe(6 + 28);

    // Decrypt step
    const decWriter = decryptTransform.writable.getWriter();
    const decReader = decryptTransform.readable.getReader();

    decWriter.write(encryptedFrame);
    decWriter.close();

    const { value: decryptedFrame } = await decReader.read();
    expect(decryptedFrame).toBeDefined();
    expect(new Uint8Array(decryptedFrame.data)).toEqual(new Uint8Array([7, 14, 21, 28, 35, 42]));
  });
});
