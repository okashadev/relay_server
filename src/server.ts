import "dotenv/config";

import app from "./app.js";

const requiredEnv = ["JWT_SECRET", "GOOGLE_CLIENT_ID", "DATABASE_URL"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`${key} is missing in environment variables.`);
  }
}

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Relay Backend running on http://localhost:${PORT}`);
});
