import { Router } from "express";
import {
  googleAuth,
  login,
  logout,
  refresh,
  register,
  resendVerificationCode,
  verifyEmail,
} from "../controllers/authController.js";
// import { googleAuthLimiter, loginLimiter, refreshLimiter, registerLimiter, resendCodeLimiter, verifyEmailLimiter } from "../middlewares/rateLimiters.js";

const authRouter = Router();

authRouter.post("/register", register);
authRouter.post("/login", login);
authRouter.post("/google-auth", googleAuth);
authRouter.post("/verify-email", verifyEmail);
authRouter.post("/resend-code", resendVerificationCode);
authRouter.post("/refresh", refresh);
authRouter.post("/logout", logout);

export default authRouter;
