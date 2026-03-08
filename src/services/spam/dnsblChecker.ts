import { BlacklistResult } from '../../types/spam';
import logger from '../../utils/logger';
import dns from 'dns';
import { promisify } from 'util';

const resolve4 = promisify(dns.resolve4);

export class DNSBLChecker {
  private static instance: DNSBLChecker;

  private blacklists = [
    'zen.spamhaus.org',
    'bl.spamcop.net',
    'dnsbl.sorbs.net',
    'b.barracudacentral.org',
    // UCEPROTECT removed: notorious false-positive generator that lists entire ESP IP ranges
    // and charges for delisting. Causes false spam flags against legitimate senders.
    // Keep: Spamhaus, SpamCop, SORBS, Barracuda (industry-standard, low false-positive rate)
  ];

  private constructor() {}

  public static getInstance(): DNSBLChecker {
    if (!DNSBLChecker.instance) {
      DNSBLChecker.instance = new DNSBLChecker();
    }
    return DNSBLChecker.instance;
  }

  public async checkBlacklists(ip: string, domain: string): Promise<BlacklistResult> {
    try {
      // Check IP-based blacklists
      const ipResults = await Promise.all(
        this.blacklists.map(bl => this.checkIPBlacklist(ip, bl))
      );

      const blacklisted = ipResults.filter(r => r.listed);

      return {
        is_blacklisted: blacklisted.length > 0,
        blacklists: blacklisted.map(r => r.blacklist),
        score: blacklisted.length / this.blacklists.length,
      };
    } catch (error) {
      logger.error('DNSBL check error:', error);
      return {
        is_blacklisted: false,
        blacklists: [],
        score: 0,
      };
    }
  }

  private async checkIPBlacklist(
    ip: string,
    blacklist: string
  ): Promise<{ listed: boolean; blacklist: string }> {
    try {
      // Reverse IP for DNSBL query
      const reversed = ip.split('.').reverse().join('.');
      const query = `${reversed}.${blacklist}`;

      // DNS lookup with timeout
      const result = await Promise.race([
        resolve4(query),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 3000)
        ),
      ]);

      return { listed: result.length > 0, blacklist };
    } catch (error) {
      // NXDOMAIN or timeout means not listed
      return { listed: false, blacklist };
    }
  }

  public extractIPFromHeaders(headers: Record<string, string>): string | null {
    try {
      // Try to extract IP from common headers
      const receivedHeader = headers['received'] || headers['Received'] || '';
      const ipMatch = receivedHeader.match(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/);
      
      if (ipMatch) {
        return ipMatch[1];
      }

      // Try X-Originating-IP
      const originatingIP = headers['x-originating-ip'] || headers['X-Originating-IP'];
      if (originatingIP) {
        const match = originatingIP.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
        if (match) return match[0];
      }

      return null;
    } catch (error) {
      logger.error('IP extraction error:', error);
      return null;
    }
  }
}
