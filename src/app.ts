import express, { ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import authRouter from "./routes/authRoutes.js";
import cookieParser from "cookie-parser";
import friendRouter from "./routes/friendRoutes.js";
import notificationRouter from "./routes/notificationRoutes.js";

const app = express();

// if (process.env.TRUST_PROXY) {
//   app.set("trust proxy", Number(process.env.TRUST_PROXY));
// }

app.use((req, res, next) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.originalUrl}`);

  res.on("finish", () =>
    console.log(
      `<-- ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`,
    ),
  );
  res.on("close", () => {
    if (!res.writableFinished) {
      console.log(`xx- ${req.method} ${req.originalUrl} connection toot gaya`);
    }
  });

  next();
});

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/friends", friendRouter);
app.use("/api/notifications", notificationRouter);

app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Route not found." });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ success: false, error: "Invalid JSON body." });
  }

  if (err.type === "entity.too.large") {
    return res
      .status(413)
      .json({ success: false, error: "Request body too large." });
  }

  console.error("Unhandled error:", err);
  return res
    .status(500)
    .json({ success: false, error: "Something went wrong." });
};

app.use(errorHandler);

export default app;
