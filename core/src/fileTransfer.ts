import {
  FileTransferPayload,
  isValidFileTransferPayload,
} from './inputProtocol.js';

export interface TransferProgress {
  transferId: string;
  fileName: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}

export interface ReceivedFile {
  transferId: string;
  name: string;
  size: number;
  mimeType: string;
  data: Uint8Array;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class FileTransferSender {
  private chunkSize: number;

  constructor(chunkSize = 16384) {
    this.chunkSize = chunkSize;
  }

  public async sendFile(
    file: { name: string; size: number; mimeType?: string; data: Uint8Array },
    sendFn: (payload: FileTransferPayload) => void,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<string> {
    const transferId = `ft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const totalBytes = file.data.byteLength;
    const totalChunks = Math.ceil(totalBytes / this.chunkSize) || 1;
    const mimeType = file.mimeType || 'application/octet-stream';

    // 1. Send start
    sendFn({
      action: 'start',
      transferId,
      fileName: file.name,
      fileSize: totalBytes,
      mimeType,
      totalChunks,
    });

    // 2. Send chunks
    let offset = 0;
    let chunkIndex = 0;

    while (offset < totalBytes || (totalBytes === 0 && chunkIndex === 0)) {
      const slice = file.data.subarray(offset, Math.min(offset + this.chunkSize, totalBytes));
      const b64 = uint8ArrayToBase64(slice);

      sendFn({
        action: 'chunk',
        transferId,
        chunkIndex,
        data: b64,
      });

      offset += slice.byteLength;
      chunkIndex++;

      if (onProgress) {
        onProgress({
          transferId,
          fileName: file.name,
          bytesTransferred: offset,
          totalBytes,
          percentage: totalBytes > 0 ? Math.min(100, Math.round((offset / totalBytes) * 100)) : 100,
        });
      }

      if (totalBytes === 0) break;

      // Yield event loop every 8 chunks to avoid freezing UI
      if (chunkIndex % 8 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // 3. Send complete
    sendFn({
      action: 'complete',
      transferId,
    });

    return transferId;
  }
}

interface InFlightTransfer {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunks: Map<number, Uint8Array>;
  receivedBytes: number;
}

export class FileTransferReceiver {
  private inFlight = new Map<string, InFlightTransfer>();

  public handlePayload(
    payload: unknown,
    onProgress?: (progress: TransferProgress) => void,
    onComplete?: (file: ReceivedFile) => void,
    onAbort?: (transferId: string, reason?: string) => void
  ): boolean {
    if (!isValidFileTransferPayload(payload)) {
      return false;
    }

    switch (payload.action) {
      case 'start': {
        this.inFlight.set(payload.transferId, {
          transferId: payload.transferId,
          fileName: payload.fileName,
          fileSize: payload.fileSize,
          mimeType: payload.mimeType,
          totalChunks: payload.totalChunks,
          chunks: new Map(),
          receivedBytes: 0,
        });
        return true;
      }
      case 'chunk': {
        const item = this.inFlight.get(payload.transferId);
        if (!item) return false;

        const bytes = base64ToUint8Array(payload.data);
        item.chunks.set(payload.chunkIndex, bytes);
        item.receivedBytes += bytes.byteLength;

        if (onProgress) {
          onProgress({
            transferId: item.transferId,
            fileName: item.fileName,
            bytesTransferred: item.receivedBytes,
            totalBytes: item.fileSize,
            percentage: item.fileSize > 0
              ? Math.min(100, Math.round((item.receivedBytes / item.fileSize) * 100))
              : 100,
          });
        }
        return true;
      }
      case 'complete': {
        const item = this.inFlight.get(payload.transferId);
        if (!item) return false;

        const assembled = new Uint8Array(item.fileSize);
        let offset = 0;
        for (let i = 0; i < item.totalChunks; i++) {
          const chunk = item.chunks.get(i);
          if (chunk) {
            assembled.set(chunk, offset);
            offset += chunk.byteLength;
          }
        }

        this.inFlight.delete(payload.transferId);

        if (onComplete) {
          onComplete({
            transferId: item.transferId,
            name: item.fileName,
            size: item.fileSize,
            mimeType: item.mimeType,
            data: assembled,
          });
        }
        return true;
      }
      case 'abort': {
        this.inFlight.delete(payload.transferId);
        if (onAbort) {
          onAbort(payload.transferId, payload.reason);
        }
        return true;
      }
    }
  }

  public cleanup(transferId?: string): void {
    if (transferId) {
      this.inFlight.delete(transferId);
    } else {
      this.inFlight.clear();
    }
  }
}

export function triggerBrowserDownload(fileName: string, data: Uint8Array, mimeType: string): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  try {
    const blob = new Blob([data as unknown as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
