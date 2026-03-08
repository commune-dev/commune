import { Router } from 'express';
import logger from '../../utils/logger';
import { UserService } from '../../services/userService';
import { OrganizationService } from '../../services/organizationService';
import { GoogleOAuthService } from '../../services/googleOAuthService';
import { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_NAME } from '../../config/freeTierConfig';
import { randomBytes } from 'crypto';
import { authLoginRateLimiter, authSignupRateLimiter, authPasswordResetRateLimiter } from '../../lib/redisRateLimiter';

const router = Router();

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return secret;
};

// Simple test endpoint to verify auth routes are working
router.get('/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ message: 'Auth routes are working!', timestamp: new Date().toISOString() });
});

// Alias /auth/signup to /auth/register for backward compatibility
router.post('/signup', authSignupRateLimiter, async (req, res) => {
  try {
    const { orgName, orgSlug, email, name, password } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }

    let orgId: string;

    if (orgName && orgSlug) {
      const org = await OrganizationService.createOrganization({
        name: orgName,
        slug: orgSlug
      });
      orgId = org.id;
    } else {
      const tempOrg = await OrganizationService.createOrganization({
        name: `${name}'s Organization`,
        slug: `org-${randomBytes(4).toString('hex')}`
      });
      orgId = tempOrg.id;
    }

    const result = await UserService.registerUser({
      orgId,
      email,
      name,
      password,
      role: 'admin'
    });

    res.status(201).json({
      message: 'User registered successfully. Please check your email to verify your account.',
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        status: result.user.status,
        orgId
      },
      requiresVerification: result.requiresVerification
    });
  } catch (error) {
    logger.error('Registration error:', { error });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Registration failed' });
  }
});

router.post('/register', authSignupRateLimiter, async (req, res) => {
  try {
    const { orgName, orgSlug, email, name, password } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }

    let orgId: string;

    if (orgName && orgSlug) {
      const org = await OrganizationService.createOrganization({
        name: orgName,
        slug: orgSlug
      });
      orgId = org.id;
    } else {
      const tempOrg = await OrganizationService.createOrganization({
        name: `${name}'s Organization`,
        slug: `org-${randomBytes(4).toString('hex')}`
      });
      orgId = tempOrg.id;
    }

    const result = await UserService.registerUser({
      orgId,
      email,
      name,
      password,
      role: 'admin'
    });

    res.status(201).json({
      message: 'User registered successfully. Please check your email to verify your account.',
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        status: result.user.status,
        orgId
      },
      requiresVerification: result.requiresVerification
    });
  } catch (error) {
    logger.error('Registration error:', { error });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Registration failed' });
  }
});

// Alias /auth/verify to /auth/verify-email for backward compatibility
router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    const result = await UserService.verifyEmail(token);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    const user = result.user!;
    const jwt = await import('jsonwebtoken');
    const authToken = jwt.sign(
      { userId: user.id, orgId: user.orgId, role: user.role },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      data: {
        verified: true,
        token: authToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          status: user.status
        }
      }
    });
  } catch (error) {
    logger.error('Email verification error:', { error });
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Add /auth/resend endpoint
router.post('/resend', authPasswordResetRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    await UserService.resendVerificationEmail(email);
    res.json({ data: { sent: true } });
  } catch (error) {
    logger.error('Resend verification error:', { error });
    res.status(500).json({ error: 'Failed to resend verification' });
  }
});

router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    const result = await UserService.verifyEmail(token);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    const user = result.user!;
    const jwt = await import('jsonwebtoken');
    const authToken = jwt.sign(
      { userId: user.id, orgId: user.orgId, role: user.role },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Email verified successfully',
      token: authToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status
      }
    });
  } catch (error) {
    logger.error('Email verification error:', { error });
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Alias /auth/signin to /auth/login for backward compatibility  
router.post('/signin', authLoginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const result = await UserService.loginUser(email, password);

    if ('error' in result) {
      if (result.error === 'email_not_verified') {
        return res.status(403).json({ error: 'Email not verified', code: 'EMAIL_NOT_VERIFIED', email: result.email });
      }
      if (result.error === 'no_password') {
        return res.status(400).json({ error: 'This account uses Google sign-in. Please sign in with Google.', code: 'NO_PASSWORD' });
      }
      if (result.error === 'account_inactive') {
        return res.status(403).json({ error: 'Account is inactive', code: 'ACCOUNT_INACTIVE' });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({
      message: 'Login successful',
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        orgId: result.user.orgId
      },
      token: result.token
    });
  } catch (error) {
    logger.error('Login error:', { error });
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/login', authLoginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const result = await UserService.loginUser(email, password);

    if ('error' in result) {
      if (result.error === 'email_not_verified') {
        return res.status(403).json({ error: 'Email not verified', code: 'EMAIL_NOT_VERIFIED', email: result.email });
      }
      if (result.error === 'no_password') {
        return res.status(400).json({ error: 'This account uses Google sign-in. Please sign in with Google.', code: 'NO_PASSWORD' });
      }
      if (result.error === 'account_inactive') {
        return res.status(403).json({ error: 'Account is inactive', code: 'ACCOUNT_INACTIVE' });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({
      message: 'Login successful',
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        orgId: result.user.orgId
      },
      token: result.token
    });
  } catch (error) {
    logger.error('Login error:', { error });
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', async (req, res) => {
  // Stateless logout - client should clear token
  res.json({ message: 'Logged out successfully' });
});

router.post('/forgot-password', authPasswordResetRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    await UserService.createPasswordResetToken(email);
    res.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
  } catch (error) {
    logger.error('Forgot password error:', { error });
    res.status(500).json({ error: 'Failed to process request' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const success = await UserService.resetPasswordWithToken(token, password);
    if (!success) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    logger.error('Reset password error:', { error });
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const jwt = await import('jsonwebtoken');

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, getJwtSecret()) as any;

    const user = await UserService.getUserById(decoded.userId);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Issue new token
    const newToken = jwt.sign(
      { userId: user.id, orgId: user.orgId, role: user.role },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      token: newToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
        status: user.status
      }
    });
  } catch (error) {
    logger.error('Refresh error:', { error });
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const jwt = await import('jsonwebtoken');

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, getJwtSecret()) as any;

    const user = await UserService.getUserById(decoded.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const org = user.orgId ? await OrganizationService.getOrganization(user.orgId) : null;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
        status: user.status
      }, 
      organization: org ? {
        id: org.id,
        name: org.name,
        slug: org.slug,
        tier: org.tier,
        settings: org.settings
      } : null,
      defaultDomain: {
        id: DEFAULT_DOMAIN_ID,
        name: DEFAULT_DOMAIN_NAME,
      },
      hasOrganization: !!org
    });
  } catch (error) {
    logger.error('Get user error:', { error });
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────

// GET /auth/google — redirect user to Google consent screen
router.get('/google', (req, res) => {
  if (!GoogleOAuthService.isConfigured()) {
    return res.status(501).json({ error: 'Google OAuth is not configured' });
  }

  const state = (req.query.redirect as string) || '/';
  const authUrl = GoogleOAuthService.getAuthorizationUrl(state);
  res.redirect(authUrl);
});

// GET /auth/google/callback — Google redirects here with ?code=...
router.get('/google/callback', async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

  try {
    const code = req.query.code as string;
    const state = (req.query.state as string) || '/';

    if (!code) {
      return res.redirect(`${FRONTEND_URL}/auth/login?error=google_no_code`);
    }

    if (!GoogleOAuthService.isConfigured()) {
      return res.redirect(`${FRONTEND_URL}/auth/login?error=google_not_configured`);
    }

    // Exchange code for tokens
    const tokens = await GoogleOAuthService.exchangeCodeForTokens(code);

    // Get user profile from Google
    const googleUser = await GoogleOAuthService.getGoogleUser(tokens.access_token, tokens.id_token);

    if (!googleUser.verified_email) {
      return res.redirect(`${FRONTEND_URL}/auth/login?error=google_unverified`);
    }

    // Find or create user in our DB
    const { user, token, isNewUser } = await UserService.findOrCreateGoogleUser({
      googleId: googleUser.id,
      email: googleUser.email,
      name: googleUser.name,
      avatarUrl: googleUser.picture,
      emailVerified: googleUser.verified_email,
    });

    // Redirect to frontend with token
    const redirectPath = isNewUser ? '/onboarding' : state;
    res.redirect(`${FRONTEND_URL}/auth/google/callback?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(redirectPath)}`);
  } catch (error) {
    logger.error('Google OAuth callback error:', { error });
    res.redirect(`${FRONTEND_URL}/auth/login?error=google_auth_failed`);
  }
});

// POST /auth/google/token — exchange a Google auth code directly (for SPA flow)
router.post('/google/token', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    if (!GoogleOAuthService.isConfigured()) {
      return res.status(501).json({ error: 'Google OAuth is not configured' });
    }

    const tokens = await GoogleOAuthService.exchangeCodeForTokens(code);
    const googleUser = await GoogleOAuthService.getGoogleUser(tokens.access_token, tokens.id_token);

    if (!googleUser.verified_email) {
      return res.status(403).json({ error: 'Google account email not verified' });
    }

    const { user, token, isNewUser } = await UserService.findOrCreateGoogleUser({
      googleId: googleUser.id,
      email: googleUser.email,
      name: googleUser.name,
      avatarUrl: googleUser.picture,
      emailVerified: googleUser.verified_email,
    });

    res.json({
      message: isNewUser ? 'Account created successfully' : 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
      },
      token,
      isNewUser,
    });
  } catch (error) {
    logger.error('Google token exchange error:', { error });
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// GET /auth/google/url — return the Google OAuth URL for frontend to redirect
router.get('/google/url', (req, res) => {
  if (!GoogleOAuthService.isConfigured()) {
    return res.status(501).json({ error: 'Google OAuth is not configured', configured: false });
  }

  const redirect = (req.query.redirect as string) || '/';
  const url = GoogleOAuthService.getAuthorizationUrl(redirect);
  res.json({ url, configured: true });
});

export default router;
