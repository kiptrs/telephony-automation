import { loginRequestSchema } from "@console/shared";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { HttpError, requireUser, SESSION_COOKIE } from "./middleware.js";
import { verifyPassword } from "./passwords.js";
import { findUserByEmail } from "./queries.js";
import { createSession, deleteSession, SESSION_TTL_DAYS } from "./sessions.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config },
): void {
  const { pool, config } = deps;

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid credentials payload");

    const user = await findUserByEmail(pool, parsed.data.email);

    // An unknown email and a wrong password must be indistinguishable, or the
    // login form becomes an account enumeration oracle. The dummy verify keeps
    // the timing comparable too.
    const ok = user
      ? await verifyPassword(user.passwordHash, parsed.data.password)
      : await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aaaa", "x");

    if (!user || !ok) throw new HttpError(401, "invalid email or password");

    const session = await createSession(pool, user.id);

    reply.setCookie(SESSION_COOKIE, session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) await deleteSession(pool, sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    const user = requireUser(request);
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };
  });
}
