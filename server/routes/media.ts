import { Router } from 'express';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { audit, HttpError, parse, requirePerm } from '../http.js';
import { validateUpload, type Purpose } from '../services/media.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

export function mediaRouter(): Router {
  const r = Router();

  r.get('/status', requirePerm('media.manage'), (req, res) => {
    res.json({ cloudinaryConfigured: req.ctx.media.enabled, folder: req.ctx.config.CLOUDINARY_FOLDER });
  });

  r.get('/', requirePerm('media.manage'), async (req, res) => {
    const items = await req.ctx.c.media.find({ purpose: 'branding', deleted: { $ne: true } }).sort({ at: -1 }).limit(100).toArray();
    res.json({ items });
  });

  /** Branding images (public delivery). */
  r.post('/branding', requirePerm('media.manage'), upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'No file uploaded', 'validation');
    const purpose: Purpose = 'branding';
    const problem = validateUpload(file.buffer, purpose);
    if (problem) {
      await audit(req, 'media.upload', 'denied', undefined, { reason: problem });
      throw new HttpError(400, problem, 'validation');
    }
    const up = await req.ctx.media.upload(file.buffer, { purpose, mime: file.mimetype, filename: file.originalname });
    const doc = { _id: new ObjectId(), publicId: up.publicId, resourceType: up.resourceType, deliveryType: up.deliveryType, purpose, format: up.format, bytes: up.bytes, uploadedBy: req.user!._id, at: new Date(), url: up.url };
    await req.ctx.c.media.insertOne(doc);
    await audit(req, 'media.upload', 'success', up.publicId, { bytes: up.bytes, purpose });
    res.status(201).json(doc);
  });

  r.post('/branding/logo', requirePerm('media.manage'), async (req, res) => {
    const { mediaId } = parse(z.object({ mediaId: z.string() }), req.body);
    if (!ObjectId.isValid(mediaId)) throw new HttpError(404, 'Media not found', 'not_found');
    const m = await req.ctx.c.media.findOne({ _id: new ObjectId(mediaId), purpose: 'branding', deleted: { $ne: true } });
    if (!m) throw new HttpError(404, 'Media not found', 'not_found');
    await req.ctx.c.settings.updateOne({ _id: 'branding' }, { $set: { value: { logoUrl: (m as unknown as { url?: string }).url ?? null }, updatedAt: new Date() } }, { upsert: true });
    await audit(req, 'media.set_logo', 'success', m.publicId);
    res.json({ ok: true });
  });

  r.delete('/:id', requirePerm('media.manage'), async (req, res) => {
    if (!ObjectId.isValid(String(req.params.id))) throw new HttpError(404, 'Media not found', 'not_found');
    const m = await req.ctx.c.media.findOne({ _id: new ObjectId(String(req.params.id)), purpose: 'branding' });
    if (!m || m.deleted) throw new HttpError(404, 'Media not found', 'not_found');
    await req.ctx.media.destroy(m.publicId, m.resourceType, m.deliveryType);
    await req.ctx.c.media.updateOne({ _id: m._id }, { $set: { deleted: true } });
    await audit(req, 'media.delete', 'success', m.publicId);
    res.json({ ok: true });
  });

  return r;
}
