// import { z } from "zod";
// import { MessageType } from "@prisma/client";

// const httpUrl = z.url({ protocol: /^https?$/ });

// // export const sendMessageSchema = z
// //   .object({
// //     type: z.enum(MessageType).default(MessageType.TEXT),
// //     content: z.string().max(5000).optional(),
// //     mediaUrl: httpUrl.optional(),
// //     thumbnailUrl: httpUrl.optional(),
// //     mediaMimeType: z
// //       .string()
// //       .regex(/^(image|video|audio|application)\/[\w.+-]+$/)
// //       .optional(),
// //     fileName: z.string().max(255).optional(),
// //     mediaSize: z
// //       .number()
// //       .int()
// //       .nonnegative()
// //       .max(50 * 1024 * 1024)
// //       .optional(),
// //     mediaWidth: z.number().int().nonnegative().optional(),
// //     mediaHeight: z.number().int().nonnegative().optional(),
// //     mediaDuration: z.number().nonnegative().optional(),
// //     metadata: z.record(z.string(), z.unknown()).optional(),
// //     replyToId: z.uuid().optional(),
// //     clientId: z.string().max(64).optional(),
// //   })
// //   .refine(
// //     (d) => (d.type === MessageType.TEXT ? !!d.content?.trim() : !!d.mediaUrl),
// //     {
// //       message: "TEXT ke liye content, media types ke liye mediaUrl zaroori hai",
// //       path: ["content"],
// //     },
// //   );
