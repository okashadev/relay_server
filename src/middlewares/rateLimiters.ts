// import rateLimit from "express-rate-limit";
// import type { Request } from "express";

// type RateLimitedRequest = Request & {
//   rateLimit?: { resetTime?: Date };
// };

// const isDisabled = process.env.RATE_LIMIT_DISABLED === "true";

// type LimiterConfig = {
//   windowMs: number;
//   limit: number;
//   message: string;
//   countOnlyFailures?: boolean;
// };

// const createLimiter = ({
//   windowMs,
//   limit,
//   message,
//   countOnlyFailures = false,
// }: LimiterConfig) => {
//   return rateLimit({
//     windowMs,
//     limit,
//     standardHeaders: "draft-7",
//     legacyHeaders: false,
//     skipSuccessfulRequests: countOnlyFailures,
//     skip: () => isDisabled,
//     handler: (req, res) => {
//       const resetTime = (req as RateLimitedRequest).rateLimit?.resetTime;
//       const retryAfterSeconds = resetTime
//         ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
//         : Math.ceil(windowMs / 1000);

//       res.status(429).json({
//         success: false,
//         error: message,
//         retryAfterSeconds,
//       });
//     },
//   });
// };

// const MINUTE = 60 * 1000;

// export const registerLimiter = createLimiter({
//   windowMs: 60 * MINUTE,
//   limit: 5,
//   message: "Too many sign-up attempts. Please try again later.",
// });

// export const loginLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 10,
//   countOnlyFailures: true,
//   message: "Too many login attempts. Please try again in a few minutes.",
// });

// export const googleAuthLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 20,
//   message: "Too many attempts. Please try again in a few minutes.",
// });

// export const verifyEmailLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 10,
//   message: "Too many verification attempts. Please try again in a few minutes.",
// });

// export const resendCodeLimiter = createLimiter({
//   windowMs: 60 * MINUTE,
//   limit: 5,
//   message: "Too many code requests. Please try again later.",
// });

// export const refreshLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 60,
//   message: "Too many requests. Please try again shortly.",
// });

// export const suggestionsLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 60,
//   message: "Too many requests. Please try again shortly.",
// });

// export const searchLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 120,
//   message: "Too many searches. Please slow down.",
// });

// export const sendRequestLimiter = createLimiter({
//   windowMs: 60 * MINUTE,
//   limit: 30,
//   message: "You're sending requests too quickly. Please try again later.",
// });

// export const cancelRequestLimiter = createLimiter({
//   windowMs: 60 * MINUTE,
//   limit: 30,
//   message: "Too many attempts. Please try again later.",
// });

// export const notificationsLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 200,
//   message: "Too many requests. Please try again shortly.",
// });

// export const requestActionLimiter = createLimiter({
//   windowMs: 60 * MINUTE,
//   limit: 60,
//   message: "Too many attempts. Please try again later.",
// });

// export const friendsListLimiter = createLimiter({
//   windowMs: 15 * MINUTE,
//   limit: 120,
//   message: "Too many requests. Please try again shortly.",
// });
