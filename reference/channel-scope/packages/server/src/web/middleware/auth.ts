import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const PUBLIC_PATHS = ['/login.html', '/setup.html', '/api/auth/login', '/api/auth/setup'];
const STATIC_EXTENSIONS = ['.css', '.js', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2'];

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('JWT_SECRET environment variable is required');
    process.exit(1);
  }
  return secret;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;

  // Skip auth for public paths
  if (PUBLIC_PATHS.includes(path)) {
    next();
    return;
  }

  // Skip auth for static assets (but never for API routes)
  if (!path.startsWith('/api/') && STATIC_EXTENSIONS.some(ext => path.endsWith(ext))) {
    next();
    return;
  }

  // Non-API paths: always pass through (SPA handles auth client-side via /api/auth/me)
  if (!path.startsWith('/api/')) {
    next();
    return;
  }

  const token = req.cookies?.token;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret());
    (req as Request & { user?: unknown }).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
