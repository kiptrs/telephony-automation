import type { FastifyRequest } from "fastify";
import type { AuthenticatedUser } from "./queries.js";

export const SESSION_COOKIE = "console_session";

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.user;
  if (!user) throw new HttpError(401, "unauthorized");
  return user;
}

/**
 * The only place a request becomes a tenantId. It reads the session and never
 * the URL or body, which is what makes tenant isolation a property of the
 * system rather than something each route has to remember.
 */
export function requireTenant(request: FastifyRequest): {
  user: AuthenticatedUser;
  tenantId: string;
} {
  const user = requireUser(request);
  if (user.tenantId === null) {
    throw new HttpError(403, "this endpoint requires a tenant account");
  }
  return { user, tenantId: user.tenantId };
}

export function requirePlatformAdmin(request: FastifyRequest): AuthenticatedUser {
  const user = requireUser(request);
  if (user.role !== "platform_admin") throw new HttpError(403, "forbidden");
  return user;
}
