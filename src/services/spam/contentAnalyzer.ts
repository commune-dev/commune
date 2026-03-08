import { ContentScore } from '../../types/spam';
import logger from '../../utils/logger';

export class ContentAnalyzer {
  private static instance: ContentAnalyzer;

  private spamKeywords = [
    // Removed AI-agent false positives: 'verify account', 'confirm identity',
    // 'unusual activity', 'password reset', 'account locked', 'suspended',
    // 'urgent', 'act now', 'credit card' — these appear in every legitimate
    // AI customer-support / transactional email and generate constant false positives.
    // Kept: terms that only appear in actual spam / scams.
    'limited time', 'click here',
    'prize', 'winner', 'congratulations you have won',
    'free money', 'cash prize', 'investment opportunity',
    'nigerian prince', 'inheritance', 'wire transfer',
    'tax refund', 'claim now',
    'dear customer', 'dear user', 'dear member',
    'social security', 'bank account',
    'lottery', 'you have been selected',
  ];

  private suspiciousPatterns = [
    /\b(click|tap)\s+(here|now|below)\b/i,
    /\b(act|respond|reply)\s+(now|immediately|urgent)\b/i,
    /\b(verify|confirm|update)\s+(your|account|payment|information)\b/i,
    /\$\d+[,\d]*(\.\d{2})?/g, // Money amounts
    /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Credit card patterns
  ];

  private constructor() {}

  public static getInstance(): ContentAnalyzer {
    if (!ContentAnalyzer.instance) {
      ContentAnalyzer.instance = new ContentAnalyzer();
    }
    return ContentAnalyzer.instance;
  }

  public async analyze(content: string, subject: string): Promise<ContentScore> {
    try {
      const fullText = `${subject} ${content}`;
      const lowerText = fullText.toLowerCase();

      // Keyword detection
      const foundKeywords = this.spamKeywords.filter(kw => 
        lowerText.includes(kw.toLowerCase())
      );

      // Capitalization analysis
      const letters = fullText.replace(/[^a-zA-Z]/g, '');
      const capsCount = (fullText.match(/[A-Z]/g) || []).length;
      const capsRatio = letters.length > 0 ? capsCount / letters.length : 0;

      // Punctuation analysis
      const punctCount = (fullText.match(/[!?]{2,}/g) || []).length;
      const punctRatio = fullText.length > 0 ? punctCount / fullText.length : 0;

      // HTML/text ratio
      const htmlTags = (content.match(/<[^>]+>/g) || []).length;
      const textLength = content.replace(/<[^>]+>/g, '').trim().length;
      const htmlTextRatio = textLength > 0 ? htmlTags / textLength : 0;

      // Suspicious patterns
      const matchedPatterns: string[] = [];
      for (const pattern of this.suspiciousPatterns) {
        if (pattern.test(fullText)) {
          matchedPatterns.push(pattern.toString());
        }
      }

      // Calculate score
      let score = 0;
      const reasons: string[] = [];

      if (foundKeywords.length > 0) {
        const keywordScore = Math.min(foundKeywords.length * 0.1, 0.4);
        score += keywordScore;
        reasons.push(`Contains ${foundKeywords.length} spam keywords`);
      }

      if (capsRatio > 0.3) {
        score += 0.2;
        reasons.push(`Excessive capitalization (${(capsRatio * 100).toFixed(1)}%)`);
      }

      if (punctCount > 0) {
        score += 0.15;
        reasons.push('Excessive punctuation');
      }

      if (htmlTextRatio > 0.5) {
        score += 0.15;
        reasons.push('High HTML/text ratio');
      }

      if (matchedPatterns.length > 0) {
        score += Math.min(matchedPatterns.length * 0.1, 0.2);
        reasons.push(`${matchedPatterns.length} suspicious patterns detected`);
      }

      // Very short content is suspicious
      if (textLength < 20 && textLength > 0) {
        score += 0.1;
        reasons.push('Very short content');
      }

      return {
        spam_score: Math.min(score, 1),
        reasons,
        signals: {
          spam_keywords: foundKeywords,
          caps_ratio: capsRatio,
          punctuation_ratio: punctRatio,
          html_text_ratio: htmlTextRatio,
          suspicious_patterns: matchedPatterns,
        },
      };
    } catch (error) {
      logger.error('Content analysis error:', error);
      return {
        spam_score: 0,
        reasons: [],
        signals: {
          spam_keywords: [],
          caps_ratio: 0,
          punctuation_ratio: 0,
          html_text_ratio: 0,
          suspicious_patterns: [],
        },
      };
    }
  }
}
