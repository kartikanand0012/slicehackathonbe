import { z } from "zod";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export const RegisterBody = z.object({
  email: z.string().email().toLowerCase().trim(),
  name: z.string().min(1).max(80).trim(),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{7,14}$/, "Invalid phone number")
    .optional(),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const RefreshBody = z.object({
  refreshToken: z.string().min(20),
});
export type RefreshBody = z.infer<typeof RefreshBody>;
