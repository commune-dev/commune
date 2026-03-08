export interface SpamScore {
  _id: string;
  email: string;
  domain: string;
  spam_score: number;
  total_emails: number;
  spam_reports: number;
  legitimate_emails: number;
  last_email_at: Date;
  first_seen_at: Date;
  blocked: boolean;
  blocked_at?: Date;
  blocked_reason?: string;
  metadata: {
    bounce_rate: number;
    complaint_rate: number;
    avg_content_score: number;
    avg_link_score: number;
  };
}

export interface SpamReport {
  _id: string;
  message_id: string;
  reporter_org_id: string;
  reporter_inbox_id: string;
  sender_email: string;
  reported_at: Date;
  reason?: string;
  auto_detected: boolean;
  classification: 'spam' | 'phishing' | 'malware' | 'other';
}

export interface DomainReputation {
  _id: string;
  domain: string;
  reputation_score: number;
  domain_age_days: number;
  is_blacklisted: boolean;
  blacklist_sources: string[];
  spf_valid: boolean;
  dkim_valid: boolean;
  dmarc_policy: string;
  last_checked_at: Date;
  total_emails: number;
  spam_count: number;
}

export interface URLBlacklist {
  _id: string;
  url: string;
  domain: string;
  blacklisted_at: Date;
  source: string;
  category: 'phishing' | 'malware' | 'spam';
  expires_at?: Date;
}

export interface ContentScore {
  spam_score: number;
  reasons: string[];
  signals: {
    spam_keywords: string[];
    caps_ratio: number;
    punctuation_ratio: number;
    html_text_ratio: number;
    suspicious_patterns: string[];
  };
}

export interface LinkScore {
  spam_score: number;
  reasons: string[];
  urls: URLAnalysis[];
}

export interface URLAnalysis {
  url: string;
  is_valid: boolean;
  is_blacklisted: boolean;
  is_shortened: boolean;
  is_broken: boolean;
  ssl_valid: boolean;
}

export interface BlacklistResult {
  is_blacklisted: boolean;
  blacklists: string[];
  score: number;
}

export interface SpamAnalysisResult {
  action: 'reject' | 'flag' | 'accept';
  spam_score: number;
  confidence: number;
  reasons: string[];
  details: {
    content_score: number;
    link_score: number;
    sender_reputation: number;
    domain_reputation: number;
    verified_sender?: boolean;
  };
  processing_time_ms: number;
}

export interface IncomingEmail {
  from: string;
  to: string[];
  subject: string;
  content: string;
  html?: string;
  headers: Record<string, string>;
}

export interface SpamStats {
  total_emails: number;
  spam_detected: number;
  spam_rejected: number;
  spam_flagged: number;
  top_spam_senders: Array<{
    email: string;
    count: number;
    score: number;
  }>;
}
