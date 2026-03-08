import { SpamScore } from '../../types/spam';

export class ReputationCalculator {
  private static instance: ReputationCalculator;

  private constructor() {}

  public static getInstance(): ReputationCalculator {
    if (!ReputationCalculator.instance) {
      ReputationCalculator.instance = new ReputationCalculator();
    }
    return ReputationCalculator.instance;
  }

  public calculateSpamScore(sender: SpamScore): number {
    const spamRate = sender.total_emails > 0 
      ? sender.spam_reports / sender.total_emails 
      : 0;
    
    const bounceRate = sender.metadata.bounce_rate;
    const complaintRate = sender.metadata.complaint_rate;
    const contentScore = sender.metadata.avg_content_score;

    // Weighted calculation
    // Content score weight intentionally kept low (0.05) to avoid the "reputation trap"
    // where AI agents that send high volumes of templated email accumulate worse content
    // averages over time even when recipients never complain or bounce.
    // Behavioral signals (spam reports, bounces, complaints) are reliable ground truth;
    // content score alone is not.
    let score = (
      spamRate * 0.5 +
      bounceRate * 0.25 +
      complaintRate * 0.2 +
      contentScore * 0.05
    );

    // Apply time decay (scores improve over time if no spam)
    const daysSinceLastEmail = this.daysBetween(
      sender.last_email_at,
      new Date()
    );

    if (daysSinceLastEmail > 0) {
      const decayFactor = Math.max(0.5, 1 - (daysSinceLastEmail / 90));
      score *= decayFactor;
    }

    // Bonus for legitimate emails
    if (sender.legitimate_emails > 10) {
      const legitimateRate = sender.legitimate_emails / sender.total_emails;
      score *= (1 - legitimateRate * 0.3);
    }

    return Math.min(Math.max(score, 0), 1);
  }

  public shouldBlock(score: number, reports: number): boolean {
    return score > 0.85 || reports > 10;
  }

  public shouldUnblock(score: number): boolean {
    return score < 0.3;
  }

  private daysBetween(date1: Date, date2: Date): number {
    const oneDay = 24 * 60 * 60 * 1000;
    return Math.round(Math.abs((date2.getTime() - date1.getTime()) / oneDay));
  }

  public updateAverageScore(
    currentAvg: number,
    totalCount: number,
    newScore: number
  ): number {
    return (currentAvg * totalCount + newScore) / (totalCount + 1);
  }
}
