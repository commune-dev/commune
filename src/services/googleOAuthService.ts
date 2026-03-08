import https from 'https';
import http from 'http';
import logger from '../utils/logger';

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || '';

interface GoogleOAuthTokens {
  access_token: string;
  id_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
  scope: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale?: string;
}

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.end();
  });
}

export class GoogleOAuthService {
  /**
   * Build the Google OAuth consent URL that the frontend redirects to.
   */
  static getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
    });

    if (state) {
      params.set('state', state);
    }

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange the authorization code for access + id tokens.
   */
  static async exchangeCodeForTokens(code: string): Promise<GoogleOAuthTokens> {
    const body = new URLSearchParams({
      code,
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();

    const response = await httpPost(
      'https://oauth2.googleapis.com/token',
      body,
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );

    const data = JSON.parse(response);

    if (data.error) {
      logger.error('Google OAuth token exchange error:', { data });
      throw new Error(`Google OAuth error: ${data.error_description || data.error}`);
    }

    return data as GoogleOAuthTokens;
  }

  /**
   * Fetch the Google user's profile using the access token.
   */
  static async getGoogleUser(accessToken: string, idToken: string): Promise<GoogleUserInfo> {
    const url = `https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=${accessToken}`;

    const response = await httpGet(url, {
      Authorization: `Bearer ${idToken}`,
    });

    const data = JSON.parse(response);

    if (data.error) {
      logger.error('Google user info error:', { data });
      throw new Error(`Failed to fetch Google user info: ${data.error.message || data.error}`);
    }

    return data as GoogleUserInfo;
  }

  /**
   * Validate that Google OAuth is configured.
   */
  static isConfigured(): boolean {
    return !!(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI);
  }
}
