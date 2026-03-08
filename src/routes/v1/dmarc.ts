import { Router, raw } from 'express';
import { requirePermission } from '../../middleware/permissions';
import { DmarcReportService } from '../../services/dmarcReportService';
import logger from '../../utils/logger';

const router = Router();

/**
 * POST /v1/dmarc/reports
 * Submit a DMARC aggregate report (XML or gzipped XML).
 * Content-Type: application/xml, application/gzip, or text/xml
 */
router.post('/reports', raw({ type: ['application/xml', 'text/xml', 'application/gzip', 'application/zip', 'application/octet-stream'], limit: '10mb' }), requirePermission('domains:write'), async (req: any, res) => {
  const orgId = req.orgId;
  const domainId = req.query.domain_id as string | undefined;

  try {
    const service = DmarcReportService.getInstance();
    const input = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const report = await service.processReport(input, orgId, domainId);

    if (!report) {
      return res.status(400).json({ error: 'Failed to parse DMARC report' });
    }

    return res.json({
      data: {
        report_id: report.report_id,
        domain: report.domain,
        org_name: report.org_name,
        date_begin: report.date_begin,
        date_end: report.date_end,
        record_count: report.records.length,
        total_messages: report.records.reduce((sum, r) => sum + r.count, 0),
      },
    });
  } catch (err) {
    logger.error('v1: DMARC report processing failed', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to process DMARC report' });
  }
});

/**
 * GET /v1/dmarc/reports
 * List DMARC reports for a domain.
 * Query: domain (required), limit (optional, default 50)
 */
router.get('/reports', requirePermission('domains:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const domain = req.query.domain as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  if (!domain) {
    return res.status(400).json({ error: 'domain query parameter is required' });
  }

  try {
    const service = DmarcReportService.getInstance();
    const reports = await service.listReports(domain, limit, orgId);
    return res.json({ data: reports });
  } catch (err) {
    logger.error('v1: Failed to list DMARC reports', { orgId, domain, error: err });
    return res.status(500).json({ error: 'Failed to list DMARC reports' });
  }
});

/**
 * GET /v1/dmarc/summary
 * Get DMARC summary for a domain over a time period.
 * Query: domain (required), days (optional, default 30)
 */
router.get('/summary', requirePermission('domains:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const domain = req.query.domain as string;
  const days = Math.min(parseInt(req.query.days as string) || 30, 365);

  if (!domain) {
    return res.status(400).json({ error: 'domain query parameter is required' });
  }

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const service = DmarcReportService.getInstance();
    const summary = await service.getDomainSummary(domain, startDate, endDate, orgId);

    if (!summary) {
      return res.json({ data: null, message: 'No DMARC reports found for this period' });
    }

    return res.json({ data: summary });
  } catch (err) {
    logger.error('v1: Failed to get DMARC summary', { orgId, domain, error: err });
    return res.status(500).json({ error: 'Failed to get DMARC summary' });
  }
});

export default router;
