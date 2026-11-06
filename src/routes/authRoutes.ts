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
import { verifyAuth } from "../middlewares/authMiddleware.js";
import {
  changePassword,
  checkEmail,
  requestEmailChange,
  verifyEmailChange,
  resendCode,
} from "../controllers/accountController.js";
import {
  listDevices,
  revokeDevice,
  revokeOtherDevices,
} from "../controllers/deviceController.js";
// import { googleAuthLimiter, loginLimiter, refreshLimiter, registerLimiter, resendCodeLimiter, verifyEmailLimiter } from "../middlewares/rateLimiters.js";

const authRouter = Router();

authRouter.post("/register", register);
authRouter.post("/login", login);
authRouter.post("/google-auth", googleAuth);

authRouter.post("/verify-email", verifyEmail);
authRouter.post("/resend-code", resendVerificationCode);

authRouter.post("/refresh", refresh);
authRouter.post("/logout", logout);

authRouter.get("/devices", verifyAuth, listDevices);
authRouter.delete("/devices/:id", verifyAuth, revokeDevice);
authRouter.post("/devices/revoke-others", verifyAuth, revokeOtherDevices);

authRouter.patch("/password", verifyAuth, changePassword);
authRouter.get("/email-available", verifyAuth, checkEmail);
authRouter.post("/change-email/request", verifyAuth, requestEmailChange);
authRouter.post("/change-email/verify", verifyAuth, verifyEmailChange);
authRouter.post("/change-email/resend-code", verifyAuth, resendCode);

export default authRouter;
