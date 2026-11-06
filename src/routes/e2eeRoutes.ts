import { Router } from "express";
import {
  disableBackup,
  getBackup,
  getConversationKeys,
  getE2eeStatus,
  getPublicKeys,
  getRotationInfo,
  registerDeviceKey,
  resetAccount,
  setupAccount,
  updateBackup,
  uploadAccountKeys,
} from "../controllers/e2eeController.js";
import { verifyAuth } from "../middlewares/authMiddleware.js";
// import {
//   backupFetchLimiter,
//   e2eeReadLimiter,
//   e2eeSetupLimiter,
// } from "../middlewares/rateLimiters.js";

const e2eeRouter = Router();

e2eeRouter.use(verifyAuth);

e2eeRouter.get("/status", getE2eeStatus);
e2eeRouter.put("/device-key", registerDeviceKey);

e2eeRouter.post("/account", setupAccount);
e2eeRouter.post("/account-keys", uploadAccountKeys);
e2eeRouter.get("/backup", getBackup);
e2eeRouter.put("/backup", updateBackup);
e2eeRouter.post("/account/reset", resetAccount);
e2eeRouter.post("/backup/off", disableBackup);

e2eeRouter.post("/public-keys", getPublicKeys);
e2eeRouter.get("/conversations/:id/keys", getConversationKeys);
e2eeRouter.get("/conversations/:id/rotation", getRotationInfo);

export default e2eeRouter;
