import z from "zod";

export const registerSchema = z.object({
  name: z
    .string()
    .min(2, "name must be atleast 2 characters.")
    .max(30, "name can be upto 30 characters."),

  username: z
    .string()
    .min(3, "Username must be at least 3 characters long!")
    .max(20, "Username cannot exceed 20 characters!"),

  email: z.email("Invalid email format! Please enter a valid email."),

  password: z.string().min(6, "Password must be at least 6 characters long!"),
});

export const loginSchema = z.object({
  email: z.email("Invalid email format! Please enter a valid email."),
  password: z.string().min(1, "Password is required!"),
});
