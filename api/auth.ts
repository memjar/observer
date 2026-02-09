import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Auth API - Email whitelist verification
 * Only authorized team members can access protected features
 */

const ALLOWED_EMAILS = [
  'james@virul.co',
  'klaus@virul.co',
  'ashley.beth.veiga@gmail.com'
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET - Check if email is allowed
  if (req.method === 'GET') {
    const email = req.query.email as string;

    if (!email) {
      return res.status(400).json({ error: 'Missing email parameter' });
    }

    const isAuthorized = ALLOWED_EMAILS.includes(email.toLowerCase());

    return res.status(200).json({
      email,
      authorized: isAuthorized,
      message: isAuthorized
        ? 'Email is authorized'
        : 'Email not in whitelist. Contact admin for access.'
    });
  }

  // POST - Verify Google token and check email
  if (req.method === 'POST') {
    const { token, email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }

    // Check whitelist
    const isAuthorized = ALLOWED_EMAILS.includes(email.toLowerCase());

    if (!isAuthorized) {
      return res.status(403).json({
        authorized: false,
        error: 'Access denied',
        message: `Email ${email} is not authorized. Only team members can access this feature.`,
        allowedEmails: ALLOWED_EMAILS
      });
    }

    // If we have a Google token, verify it
    if (token) {
      try {
        const googleResponse = await fetch(
          `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`
        );

        if (!googleResponse.ok) {
          return res.status(401).json({
            authorized: false,
            error: 'Invalid token'
          });
        }

        const tokenInfo = await googleResponse.json();

        // Verify the email matches the token
        if (tokenInfo.email?.toLowerCase() !== email.toLowerCase()) {
          return res.status(403).json({
            authorized: false,
            error: 'Email mismatch'
          });
        }

        return res.status(200).json({
          authorized: true,
          email: tokenInfo.email,
          expiresIn: tokenInfo.expires_in
        });
      } catch (error) {
        return res.status(500).json({
          authorized: false,
          error: 'Token verification failed'
        });
      }
    }

    // No token, just whitelist check passed
    return res.status(200).json({
      authorized: true,
      email
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
