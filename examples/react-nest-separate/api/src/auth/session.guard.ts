import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { sessionFor, type SessionUser } from './sessions.js';

export interface SessionRequest {
  headers: { cookie?: string; authorization?: string };
  user?: SessionUser;
}

/** Lets a request through only with a session cookie or bearer token of a signed-in user. */
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const user = sessionFor(request.headers);
    if (!user) throw new UnauthorizedException({ error: 'Unauthenticated' });
    request.user = user;
    return true;
  }
}
