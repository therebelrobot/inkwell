import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal ZIP writer (deflate, UTF-8 names, no zip64) so exports need no
 * archive dependency. Fine for story projects: zip64 only matters past 4 GB
 * or 65,535 entries.
 */

export interface ZipEntryInput {
  pathInArchive: string;
  content: string | Buffer;
  modifiedAt?: Date;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED_TO_EXTRACT_DEFLATE = 20;
const GENERAL_PURPOSE_FLAG_UTF8_NAMES = 0x0800;
const COMPRESSION_METHOD_DEFLATE = 8;

function toDosDateAndTime(timestamp: Date): { dosTime: number; dosDate: number } {
  const clampedYear = Math.max(1980, timestamp.getFullYear());
  return {
    dosTime: (timestamp.getHours() << 11) | (timestamp.getMinutes() << 5) | Math.floor(timestamp.getSeconds() / 2),
    dosDate: ((clampedYear - 1980) << 9) | ((timestamp.getMonth() + 1) << 5) | timestamp.getDate(),
  };
}

export function buildZipArchive(entries: ZipEntryInput[]): Buffer {
  const localSectionChunks: Buffer[] = [];
  const centralDirectoryChunks: Buffer[] = [];
  let currentLocalOffset = 0;

  for (const entry of entries) {
    const uncompressedBytes = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const compressedBytes = deflateRawSync(uncompressedBytes);
    const fileNameBytes = Buffer.from(entry.pathInArchive, "utf8");
    const checksum = crc32(uncompressedBytes);
    const { dosTime, dosDate } = toDosDateAndTime(entry.modifiedAt ?? new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_DEFLATE, 4);
    localHeader.writeUInt16LE(GENERAL_PURPOSE_FLAG_UTF8_NAMES, 6);
    localHeader.writeUInt16LE(COMPRESSION_METHOD_DEFLATE, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedBytes.length, 18);
    localHeader.writeUInt32LE(uncompressedBytes.length, 22);
    localHeader.writeUInt16LE(fileNameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_DEFLATE, 4); // version made by
    centralHeader.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_DEFLATE, 6);
    centralHeader.writeUInt16LE(GENERAL_PURPOSE_FLAG_UTF8_NAMES, 8);
    centralHeader.writeUInt16LE(COMPRESSION_METHOD_DEFLATE, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedBytes.length, 20);
    centralHeader.writeUInt32LE(uncompressedBytes.length, 24);
    centralHeader.writeUInt16LE(fileNameBytes.length, 28);
    // extra length, comment length, disk number, internal attrs, external attrs stay 0
    centralHeader.writeUInt32LE(currentLocalOffset, 42);

    localSectionChunks.push(localHeader, fileNameBytes, compressedBytes);
    centralDirectoryChunks.push(centralHeader, fileNameBytes);
    currentLocalOffset += localHeader.length + fileNameBytes.length + compressedBytes.length;
  }

  const centralDirectory = Buffer.concat(centralDirectoryChunks);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(currentLocalOffset, 16);

  return Buffer.concat([...localSectionChunks, centralDirectory, endRecord]);
}
