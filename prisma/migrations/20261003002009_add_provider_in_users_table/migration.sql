-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "provider" "AuthProvider" NOT NULL DEFAULT 'LOCAL';
