import { timingSafeEqual } from 'node:crypto';

export function requireApiAuth(config) {
  return (req, res, next) => {
    if (req.path === '/v1/health') return next();
    if (req.path.startsWith('/v1/onboarding/oauth/')) return next(); // covers both slack + gdrive
    if (req.path === '/v1/auth/refresh') return next();
    if (req.path === '/v1/webhooks/slack/events') return next();
    if (req.path === '/v1/webhooks/google-drive/changes') return next();
    if (req.path === '/v1/webhooks/azure-blob/events') return next();
    if (!req.path.startsWith('/v1/')) return next();
    if (!config.auth?.required) return next();
    if (['jwt', 'api_key'].includes(config.identity?.mode)) return next();

    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!constantTimeEquals(token, config.auth.token)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  };
}

function constantTimeEquals(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
