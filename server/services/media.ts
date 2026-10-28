/**
 * Media storage via Cloudinary (server-side SDK only).
 *
 * - Branding/public website images: delivery type "upload" (public URLs).
 * - Officer profile images and collation supporting documents: delivery type "private";
 *   viewers receive short-lived signed download URLs generated after an authorisation check.
 * - The register PDFs, extracted records and any voter data are never sent here.
 */
import { v2 as cloudinary } from 'cloudinary';
import type { AppConfig } from '../config.js';

export type Purpose = 'branding' | 'profile' | 'submission' | 'report';

export interface UploadResult {
  publicId: string;
  resourceType: string;
  deliveryType: 'upload' | 'private';
  format: string;
  bytes: number;
  url?: string; // only for public branding assets
}

export interface MediaService {
  enabled: boolean;
  upload(buf: Buffer, opts: { purpose: Purpose; mime: string; filename: string }): Promise<UploadResult>;
  destroy(publicId: string, resourceType: string, deliveryType: string): Promise<void>;
  signedUrl(publicId: string, resourceType: string, format: string, ttlSeconds?: number): string;
}

/** Allowed types per purpose, validated by magic bytes (not by the client-supplied MIME type). */
export const ALLOWED: Record<Purpose, { mimes: string[]; maxBytes: number }> = {
  branding: { mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'], maxBytes: 5 * 1024 * 1024 },
  profile: { mimes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 2 * 1024 * 1024 },
  submission: { mimes: ['application/pdf', 'image/png', 'image/jpeg'], maxBytes: 10 * 1024 * 1024 },
  report: { mimes: ['application/pdf'], maxBytes: 20 * 1024 * 1024 },
};

export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Returns a problem description, or null if the file is acceptable for the purpose. */
export function validateUpload(buf: Buffer, purpose: Purpose): string | null {
  const rule = ALLOWED[purpose];
  if (buf.length === 0) return 'File is empty';
  if (buf.length > rule.maxBytes) return `File exceeds ${Math.round(rule.maxBytes / 1048576)} MB`;
  const mime = sniffMime(buf);
  if (!mime || !rule.mimes.includes(mime)) return `File type not allowed (allowed: ${rule.mimes.join(', ')})`;
  if (mime === 'image/svg+xml' && /<script|on\w+\s*=|javascript:/i.test(buf.toString('utf8'))) return 'SVG contains active content';
  return null;
}

export function createMediaService(config: AppConfig): MediaService {
  const enabled = !!(config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET);
  if (enabled) {
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
  const notConfigured = () => {
    throw Object.assign(new Error('Cloudinary is not configured'), { status: 503 });
  };
  return {
    enabled,
    async upload(buf, { purpose }) {
      if (!enabled) notConfigured();
      const isPublic = purpose === 'branding';
      const mime = sniffMime(buf)!;
      const resourceType = mime === 'application/pdf' ? 'raw' : 'image';
      const r = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `${config.CLOUDINARY_FOLDER}/${purpose}`,
            type: isPublic ? 'upload' : 'private',
            resource_type: resourceType,
            use_filename: false,
            unique_filename: true,
            overwrite: false,
          },
          (err, res) => (err || !res ? reject(err ?? new Error('Upload failed')) : resolve(res as unknown as Record<string, unknown>)),
        );
        stream.end(buf);
      });
      return {
        publicId: String(r.public_id),
        resourceType,
        deliveryType: isPublic ? 'upload' : 'private',
        format: String(r.format ?? (resourceType === 'raw' ? 'pdf' : '')),
        bytes: Number(r.bytes ?? buf.length),
        url: isPublic ? String(r.secure_url) : undefined,
      };
    },
    async destroy(publicId, resourceType, deliveryType) {
      if (!enabled) notConfigured();
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: deliveryType, invalidate: true });
    },
    signedUrl(publicId, resourceType, format, ttlSeconds = 300) {
      if (!enabled) notConfigured();
      return cloudinary.utils.private_download_url(publicId, format, {
        resource_type: resourceType,
        type: 'private',
        expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
        attachment: true,
      });
    },
  };
}
