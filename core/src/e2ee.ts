/**
 * WebRTC End-to-End Encryption (E2EE) module using Web Crypto API.
 * Uses PBKDF2-HMAC-SHA256 for key derivation from room PIN
 * and AES-GCM 256-bit for frame encryption/decryption.
 */

export const E2EE_SALT = new TextEncoder().encode('OmniSpace-E2EE-Room-Key-Salt-v1');
export const E2EE_ITERATIONS = 100_000;
export const IV_LENGTH = 12;

export async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array = E2EE_SALT,
  iterations = E2EE_ITERATIONS
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const rawKeyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    rawKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptFrameData(
  key: CryptoKey,
  data: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const rawData = data instanceof Uint8Array ? data : new Uint8Array(data);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    rawData as unknown as BufferSource
  );

  // Format: [12 bytes IV] + [AES-GCM Ciphertext + 16 bytes Auth Tag]
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);

  return result;
}

export async function decryptFrameData(
  key: CryptoKey,
  encryptedData: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  const bytes = encryptedData instanceof Uint8Array ? encryptedData : new Uint8Array(encryptedData);
  if (bytes.length < IV_LENGTH + 16) {
    throw new Error('Encrypted payload is too short to contain IV and auth tag');
  }

  const iv = bytes.subarray(0, IV_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource
  );

  return new Uint8Array(decrypted);
}

export function createEncryptionTransform(key: CryptoKey) {
  return new TransformStream({
    async transform(frame: { data: ArrayBuffer; [k: string]: any }, controller) {
      try {
        const encrypted = await encryptFrameData(key, frame.data);
        frame.data = encrypted.buffer.slice(
          encrypted.byteOffset,
          encrypted.byteOffset + encrypted.byteLength
        ) as ArrayBuffer;
        controller.enqueue(frame);
      } catch (err) {
        console.error('[E2EE] Frame encryption error:', err);
      }
    },
  });
}

export function createDecryptionTransform(key: CryptoKey) {
  return new TransformStream({
    async transform(frame: { data: ArrayBuffer; [k: string]: any }, controller) {
      try {
        const decrypted = await decryptFrameData(key, frame.data);
        frame.data = decrypted.buffer.slice(
          decrypted.byteOffset,
          decrypted.byteOffset + decrypted.byteLength
        ) as ArrayBuffer;
        controller.enqueue(frame);
      } catch (err) {
        console.error('[E2EE] Frame decryption error:', err);
      }
    },
  });
}
