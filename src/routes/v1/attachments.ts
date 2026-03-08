import { Router } from 'express';
import messageStore from '../../stores/messageStore';
import { AttachmentStorageService } from '../../services/attachmentStorageService';
import { requirePermission } from '../../middleware/permissions';
import logger from '../../utils/logger';
import crypto from 'crypto';

const router = Router();

/**
 * POST /v1/attachments/upload
 * Upload an attachment for later use when sending emails.
 *
 * Body:
 *   content   - Base64-encoded file content
 *   filename  - Original filename (e.g. "invoice.pdf")
 *   mime_type - MIME type (e.g. "application/pdf")
 *
 * Returns: { attachment_id, filename, mime_type, size }
 */
router.post('/upload', requirePermission('attachments:write'), async (req: any, res) => {
  const orgId = req.orgId;
  const { content, filename, mime_type, mimeType } = req.body || {};
  const mt = mime_type || mimeType;

  if (!content || !filename || !mt) {
    return res.status(400).json({ error: 'Missing required fields: content, filename, mime_type' });
  }

  try {
    const buffer = Buffer.from(content, 'base64');
    const attachmentStorageService = AttachmentStorageService.getInstance();

    // Check storage quota before uploading
    if (orgId) {
      const quota = await attachmentStorageService.checkStorageQuota(orgId, buffer.length);
      if (!quota.allowed) {
        const limitMB = Math.round(quota.limit / (1024 * 1024));
        const usedMB = Math.round(quota.used / (1024 * 1024));
        return res.status(413).json({
          error: 'Attachment storage limit exceeded',
          used_mb: usedMB,
          limit_mb: limitMB,
          upgrade_url: '/dashboard/billing',
        });
      }
    }

    const uploadResult = await attachmentStorageService.uploadAttachment(
      buffer,
      filename,
      mt,
      orgId
    );

    // Track storage usage
    if (orgId) {
      await attachmentStorageService.trackStorageUsage(orgId, buffer.length);
    }

    const attachmentId = crypto.randomBytes(16).toString('hex');

    const attachmentRecord = {
      attachment_id: attachmentId,
      message_id: '',
      filename,
      mime_type: mt,
      size: buffer.length,
      content_base64: uploadResult.storage_type === 'database' ? content : null,
      storage_type: uploadResult.storage_type,
      cloudinary_url: uploadResult.cloudinary_url || null,
      cloudinary_public_id: uploadResult.cloudinary_public_id || null,
      source: 'email' as const,
    };

    await messageStore.insertAttachments([attachmentRecord]);

    logger.info('v1: Attachment uploaded', { orgId, attachmentId, filename });

    return res.status(201).json({
      data: {
        attachment_id: attachmentId,
        filename,
        mime_type: mt,
        size: buffer.length,
      },
    });
  } catch (err) {
    logger.error('v1: Attachment upload failed', { orgId, filename, error: err });
    return res.status(500).json({ error: 'Failed to upload attachment' });
  }
});

/**
 * GET /v1/attachments/:attachmentId
 * Get attachment metadata.
 */
router.get('/:attachmentId', requirePermission('attachments:read'), async (req: any, res) => {
  const { attachmentId } = req.params;

  try {
    const attachment = await messageStore.getAttachment(attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const { content_base64, ...metadata } = attachment;
    return res.json({ data: metadata });
  } catch (err) {
    logger.error('v1: Failed to get attachment', { attachmentId, error: err });
    return res.status(500).json({ error: 'Failed to get attachment' });
  }
});

/**
 * GET /v1/attachments/:attachmentId/url
 * Get a temporary download URL for an attachment.
 *
 * Query params:
 *   expires_in - URL expiration in seconds (default 3600)
 */
router.get('/:attachmentId/url', requirePermission('attachments:read'), async (req: any, res) => {
  const { attachmentId } = req.params;
  const expiresIn = parseInt(req.query.expires_in as string) || 3600;

  try {
    const attachment = await messageStore.getAttachment(attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    if (attachment.storage_type === 'cloudinary' && attachment.cloudinary_public_id) {
      const attachmentStorageService = AttachmentStorageService.getInstance();
      if (!attachmentStorageService.isCloudinaryConfigured()) {
        return res.status(500).json({ error: 'Storage not configured' });
      }

      const signedUrl = await attachmentStorageService.generateSignedUrl(
        attachment.cloudinary_public_id,
        expiresIn
      );

      return res.json({
        data: {
          url: signedUrl,
          expires_in: expiresIn,
          filename: attachment.filename,
          mime_type: attachment.mime_type,
          size: attachment.size,
        },
      });
    }

    if (attachment.storage_type === 'database' && attachment.content_base64) {
      const dataUrl = `data:${attachment.mime_type};base64,${attachment.content_base64}`;
      return res.json({
        data: {
          url: dataUrl,
          expires_in: 0,
          filename: attachment.filename,
          mime_type: attachment.mime_type,
          size: attachment.size,
        },
      });
    }

    return res.status(400).json({ error: 'Attachment has no accessible content' });
  } catch (err) {
    logger.error('v1: Failed to get attachment URL', { attachmentId, error: err });
    return res.status(500).json({ error: 'Failed to get attachment URL' });
  }
});

export default router;
