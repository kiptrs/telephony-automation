import { z } from "zod";

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: z.enum(["platform_admin", "member"]),
  tenantId: z.string().uuid().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
