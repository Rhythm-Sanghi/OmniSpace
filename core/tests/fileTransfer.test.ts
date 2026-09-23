import { describe, it, expect, vi } from 'vitest';
import {
  FileTransferSender,
  FileTransferReceiver,
  uint8ArrayToBase64,
  base64ToUint8Array,
  triggerBrowserDownload,
  isValidFileTransferPayload,
  FileTransferPayload,
} from '../src/index.js';

describe('Cross-Device Chunked File Transfer Protocol', () => {
  it('encodes and decodes base64 buffers correctly', () => {
    const original = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    const b64 = uint8ArrayToBase64(original);
    const decoded = base64ToUint8Array(b64);
    expect(decoded).toEqual(original);
  });

  it('validates FileTransferPayload accurately', () => {
    expect(
      isValidFileTransferPayload({
        action: 'start',
        transferId: 't-1',
        fileName: 'report.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        totalChunks: 1,
      })
    ).toBe(true);

    expect(
      isValidFileTransferPayload({
        action: 'chunk',
        transferId: 't-1',
        chunkIndex: 0,
        data: 'AAEC',
      })
    ).toBe(true);

    expect(
      isValidFileTransferPayload({
        action: 'complete',
        transferId: 't-1',
      })
    ).toBe(true);

    expect(
      isValidFileTransferPayload({
        action: 'abort',
        transferId: 't-1',
        reason: 'User cancelled',
      })
    ).toBe(true);

    // Invalid cases
    expect(isValidFileTransferPayload(null)).toBe(false);
    expect(isValidFileTransferPayload({ action: 'start' })).toBe(false);
    expect(isValidFileTransferPayload({ transferId: '', action: 'complete' })).toBe(false);
    expect(
      isValidFileTransferPayload({
        action: 'start',
        transferId: 't-1',
        fileName: '', // empty name
        fileSize: 10,
        mimeType: 'text/plain',
        totalChunks: 1,
      })
    ).toBe(false);
    expect(
      isValidFileTransferPayload({
        action: 'chunk',
        transferId: 't-1',
        chunkIndex: -1, // negative chunk index
        data: 'abc',
      })
    ).toBe(false);
  });

  it('transfers a multi-chunk file with progress and reassembles exactly', async () => {
    const sender = new FileTransferSender(1024); // 1 KB chunks
    const receiver = new FileTransferReceiver();

    // 3.5 KB file
    const fileData = new Uint8Array(3500);
    for (let i = 0; i < fileData.length; i++) {
      fileData[i] = (i * 7 + 13) % 256;
    }

    const sentPayloads: FileTransferPayload[] = [];
    const senderProgress: number[] = [];
    const receiverProgress: number[] = [];

    let completedFile: any = null;

    const transferId = await sender.sendFile(
      {
        name: 'test-data.bin',
        size: fileData.length,
        mimeType: 'application/octet-stream',
        data: fileData,
      },
      (payload) => {
        sentPayloads.push(payload);
        // Deliver to receiver immediately
        receiver.handlePayload(
          payload,
          (prog) => receiverProgress.push(prog.percentage),
          (file) => {
            completedFile = file;
          }
        );
      },
      (prog) => senderProgress.push(prog.percentage)
    );

    expect(transferId).toBeDefined();
    expect(sentPayloads.length).toBe(6); // 1 start + 4 chunks (1024*3 + 428) + 1 complete
    expect(completedFile).not.toBeNull();
    expect(completedFile.name).toBe('test-data.bin');
    expect(completedFile.size).toBe(3500);
    expect(completedFile.mimeType).toBe('application/octet-stream');
    expect(completedFile.data.length).toBe(3500);
    expect(completedFile.data).toEqual(fileData);

    // Verify progress went to 100%
    expect(senderProgress[senderProgress.length - 1]).toBe(100);
    expect(receiverProgress[receiverProgress.length - 1]).toBe(100);
  });

  it('handles empty files gracefully', async () => {
    const sender = new FileTransferSender(1024);
    const receiver = new FileTransferReceiver();

    const emptyData = new Uint8Array(0);
    let completedFile: any = null;

    await sender.sendFile(
      {
        name: 'empty.txt',
        size: 0,
        mimeType: 'text/plain',
        data: emptyData,
      },
      (payload) => {
        receiver.handlePayload(
          payload,
          undefined,
          (file) => {
            completedFile = file;
          }
        );
      }
    );

    expect(completedFile).not.toBeNull();
    expect(completedFile.name).toBe('empty.txt');
    expect(completedFile.size).toBe(0);
    expect(completedFile.data.length).toBe(0);
  });

  it('handles abort properly and triggers onAbort callback', () => {
    const receiver = new FileTransferReceiver();
    const abortSpy = vi.fn();

    receiver.handlePayload({
      action: 'start',
      transferId: 'abort-1',
      fileName: 'cancel.bin',
      fileSize: 1000,
      mimeType: 'application/octet-stream',
      totalChunks: 1,
    });

    receiver.handlePayload(
      {
        action: 'abort',
        transferId: 'abort-1',
        reason: 'Cancelled by peer',
      },
      undefined,
      undefined,
      abortSpy
    );

    expect(abortSpy).toHaveBeenCalledWith('abort-1', 'Cancelled by peer');
  });

  it('safely handles browser download trigger when not in DOM', () => {
    // In vitest Node environment where window/document might not be full DOM
    const result = triggerBrowserDownload('test.txt', new Uint8Array([1, 2, 3]), 'text/plain');
    expect(typeof result).toBe('boolean');
  });
});
