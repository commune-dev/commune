import logger from '../../utils/logger';

interface EmailBurst {
  count: number;
  firstSeen: number;
  lastSeen: number;
  senders: Map<string, number>;
  avgSpamScore: number;
  lowQualityCount: number;
}

export class MassEmailDetector {
  private static instance: MassEmailDetector;
  
  // Track email bursts per organization
  private orgBursts: Map<string, EmailBurst> = new Map();
  
  // Thresholds
  private readonly BURST_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private readonly NORMAL_RATE_THRESHOLD = 50; // emails per 5 min (unknown senders)
  private readonly ATTACK_RATE_THRESHOLD = 100; // emails per 5 min (unknown senders)
  // Verified senders (domains set up through Commune) are legitimate AI agents / SDRs.
  // Raise their threshold significantly — 10,000/5 min — so bulk sends don't trigger
  // mass-attack detection. They still go through DNSBL and behavioral reputation checks.
  private readonly VERIFIED_ATTACK_RATE_THRESHOLD = 10000; // emails per 5 min (verified)
  private readonly LOW_QUALITY_RATIO = 0.6; // 60% low quality = attack
  private readonly LOW_QUALITY_SPAM_SCORE = 0.4; // score > 0.4 = low quality

  private constructor() {
    // Clean up old burst data every minute
    setInterval(() => this.cleanupOldBursts(), 60 * 1000);
  }

  public static getInstance(): MassEmailDetector {
    if (!MassEmailDetector.instance) {
      MassEmailDetector.instance = new MassEmailDetector();
    }
    return MassEmailDetector.instance;
  }

  public async checkMassEmailAttack(
    orgId: string,
    senderEmail: string,
    spamScore: number,
    domainReputation: number,
    isVerifiedSender: boolean = false
  ): Promise<{
    isAttack: boolean;
    shouldReject: boolean;
    reason?: string;
    burstStats: {
      emailCount: number;
      uniqueSenders: number;
      lowQualityRatio: number;
      avgSpamScore: number;
    };
  }> {
    const now = Date.now();
    
    // Get or create burst tracking for this org
    let burst = this.orgBursts.get(orgId);
    
    if (!burst || now - burst.lastSeen > this.BURST_WINDOW_MS) {
      // Start new burst window
      burst = {
        count: 0,
        firstSeen: now,
        lastSeen: now,
        senders: new Map(),
        avgSpamScore: 0,
        lowQualityCount: 0,
      };
      this.orgBursts.set(orgId, burst);
    }

    // Update burst data
    burst.count++;
    burst.lastSeen = now;
    burst.senders.set(senderEmail, (burst.senders.get(senderEmail) || 0) + 1);
    
    // Update average spam score
    burst.avgSpamScore = (burst.avgSpamScore * (burst.count - 1) + spamScore) / burst.count;
    
    // Track low quality emails
    const isLowQuality = spamScore > this.LOW_QUALITY_SPAM_SCORE || domainReputation > 0.5;
    if (isLowQuality) {
      burst.lowQualityCount++;
    }

    // Calculate metrics
    const lowQualityRatio = burst.lowQualityCount / burst.count;
    const emailsPerMinute = burst.count / ((now - burst.firstSeen) / 60000);

    // Determine if this is an attack.
    // Verified senders use a much higher volume threshold — they are legitimate AI agents
    // running bulk sends (SDRs, support agents) and should not be flagged for volume alone.
    const attackThreshold = isVerifiedSender
      ? this.VERIFIED_ATTACK_RATE_THRESHOLD
      : this.ATTACK_RATE_THRESHOLD;
    const isHighVolume = burst.count > attackThreshold;
    const isLowQualityBurst = lowQualityRatio > this.LOW_QUALITY_RATIO;
    const isAttack = isHighVolume && isLowQualityBurst;

    // Determine if we should reject this specific email
    let shouldReject = false;
    let reason: string | undefined;

    if (isAttack) {
      // During an attack, reject low quality emails
      if (isLowQuality) {
        shouldReject = true;
        reason = 'Mass email attack detected - low quality email rejected';
      }
    } else if (!isVerifiedSender && burst.count > this.NORMAL_RATE_THRESHOLD && isLowQualityBurst) {
      // Approaching attack threshold with low quality (skip check for verified senders)
      if (spamScore > 0.6) {
        shouldReject = true;
        reason = 'High volume of low quality emails - rejecting suspicious email';
      }
    }

    if (isAttack || shouldReject) {
      logger.warn('Mass email attack detected', {
        orgId,
        emailCount: burst.count,
        uniqueSenders: burst.senders.size,
        lowQualityRatio,
        avgSpamScore: burst.avgSpamScore,
        emailsPerMinute,
        isAttack,
        shouldReject,
      });
    }

    return {
      isAttack,
      shouldReject,
      reason,
      burstStats: {
        emailCount: burst.count,
        uniqueSenders: burst.senders.size,
        lowQualityRatio,
        avgSpamScore: burst.avgSpamScore,
      },
    };
  }

  private cleanupOldBursts(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [orgId, burst] of this.orgBursts.entries()) {
      if (now - burst.lastSeen > this.BURST_WINDOW_MS) {
        toDelete.push(orgId);
      }
    }

    toDelete.forEach(orgId => this.orgBursts.delete(orgId));

    if (toDelete.length > 0) {
      logger.debug('Cleaned up old burst data', { count: toDelete.length });
    }
  }

  public getBurstStats(orgId: string): EmailBurst | null {
    return this.orgBursts.get(orgId) || null;
  }

  public resetBurst(orgId: string): void {
    this.orgBursts.delete(orgId);
    logger.info('Burst tracking reset', { orgId });
  }
}
