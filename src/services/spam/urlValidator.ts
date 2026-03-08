import { LinkScore, URLAnalysis } from '../../types/spam';
import logger from '../../utils/logger';
import { getCollection } from '../../db';
import { PhishingDetector } from './phishingDetector';
import { DomainAuthorityChecker } from './domainAuthorityChecker';

export class URLValidator {
  private static instance: URLValidator;
  private phishingDetector: PhishingDetector;
  private domainAuthorityChecker: DomainAuthorityChecker;

  private shortenedDomains = [
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly',
    'buff.ly', 'adf.ly', 'is.gd', 'tiny.cc', 'cli.gs'
  ];

  private constructor() {
    this.phishingDetector = PhishingDetector.getInstance();
    this.domainAuthorityChecker = DomainAuthorityChecker.getInstance();
  }

  public static getInstance(): URLValidator {
    if (!URLValidator.instance) {
      URLValidator.instance = new URLValidator();
    }
    return URLValidator.instance;
  }

  public async validateUrls(content: string, emailSubject: string = ''): Promise<LinkScore> {
    try {
      // Extract URLs
      const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
      const urls = content.match(urlRegex) || [];

      if (urls.length === 0) {
        return { spam_score: 0, reasons: [], urls: [] };
      }

      // Run phishing detection on all URLs
      const phishingAnalysis = await this.phishingDetector.analyzeForPhishing(
        content,
        emailSubject,
        urls
      );

      // Analyze each URL (with timeout)
      const analyses = await Promise.all(
        urls.slice(0, 20).map(url => this.analyzeUrl(url))
      );

      // Calculate score
      let score = 0;
      const reasons: string[] = [];

      // Add phishing detection results
      if (phishingAnalysis.is_phishing) {
        score += phishingAnalysis.confidence * 0.6; // Heavy weight for phishing
        reasons.push(...phishingAnalysis.reasons);
        
        if (phishingAnalysis.detected_brand) {
          reasons.push(`Possible ${phishingAnalysis.detected_brand} impersonation`);
        }
      }

      const brokenLinks = analyses.filter((a: URLAnalysis) => a.is_broken).length;
      const blacklistedLinks = analyses.filter((a: URLAnalysis) => a.is_blacklisted).length;
      const shortenedLinks = analyses.filter((a: URLAnalysis) => a.is_shortened).length;
      const insecureLinks = analyses.filter((a: URLAnalysis) => !a.ssl_valid).length;

      if (urls.length > 10) {
        score += 0.2;
        reasons.push(`Too many URLs (${urls.length})`);
      }

      if (brokenLinks > 2) {
        score += 0.3;
        reasons.push(`${brokenLinks} broken links`);
      }

      if (blacklistedLinks > 0) {
        score += 0.5;
        reasons.push(`${blacklistedLinks} blacklisted URLs`);
      }

      if (shortenedLinks > 3) {
        score += 0.15;
        reasons.push(`${shortenedLinks} shortened URLs`);
      }

      if (insecureLinks > urls.length / 2) {
        score += 0.1;
        reasons.push('Majority of links are not HTTPS');
      }

      // Domain authority check (includes outbound HTTPS fetches via checkSSLCertificate)
      // Deferred to setImmediate — does not block validateUrls return value
      if (phishingAnalysis.suspicious_domains.length > 0) {
        const uniqueDomains = [...new Set(phishingAnalysis.suspicious_domains)];
        setImmediate(async () => {
          try {
            const authorityResults = await this.domainAuthorityChecker.checkMultipleDomains(
              uniqueDomains.slice(0, 5)
            );
            const lowAuthorityDomains = authorityResults.filter(r => r.authority_score < 0.4);
            if (lowAuthorityDomains.length > 0) {
              logger.info('Deferred domain authority check: low-authority domains found', {
                count: lowAuthorityDomains.length,
                domains: lowAuthorityDomains.map(r => r.domain),
              });
            }
          } catch (err) {
            logger.warn('Deferred domain authority check failed', { error: err });
          }
        });
      }

      return {
        spam_score: Math.min(score, 1),
        reasons,
        urls: analyses,
      };
    } catch (error) {
      logger.error('URL validation error:', error);
      return { spam_score: 0, reasons: [], urls: [] };
    }
  }

  private async analyzeUrl(url: string): Promise<URLAnalysis> {
    try {
      const parsedUrl = new URL(url);
      const domain = parsedUrl.hostname;

      // Check if shortened URL
      const isShortened = this.shortenedDomains.some(d => domain.includes(d));

      // Check blacklist
      const isBlacklisted = await this.checkUrlBlacklist(url);

      // Check SSL
      const sslValid = url.startsWith('https://');

      // Try to check if link is broken (with timeout)
      let isBroken = false;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'manual',
        });

        clearTimeout(timeoutId);
        isBroken = response.status >= 400 && response.status < 600;
      } catch (error) {
        // If fetch fails, don't automatically mark as broken
        // (could be timeout or network issue)
        isBroken = false;
      }

      return {
        url,
        is_valid: !isBroken,
        is_blacklisted: isBlacklisted,
        is_shortened: isShortened,
        is_broken: isBroken,
        ssl_valid: sslValid,
      };
    } catch (error) {
      return {
        url,
        is_valid: false,
        is_blacklisted: false,
        is_shortened: false,
        is_broken: true,
        ssl_valid: false,
      };
    }
  }

  private async checkUrlBlacklist(url: string): Promise<boolean> {
    try {
      const collection = await getCollection('url_blacklist');
      if (!collection) return false;

      const result = await collection.findOne({ url });
      return !!result;
    } catch (error) {
      logger.error('URL blacklist check error:', error);
      return false;
    }
  }
}
