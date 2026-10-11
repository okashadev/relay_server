import { Response } from "express";
import { ZodError } from "zod";

const sendError = (
  res: Response,
  status: number,
  error: string,
  extra?: Record<string, unknown>,
) => res.status(status).json({ success: false, error, ...extra });

export const badRequest = (res: Response, error: string) =>
  sendError(res, 400, error);

export const unauthorized = (
  res: Response,
  error = "Access denied. No token provided.",
) => sendError(res, 401, error);

export const notFound = (res: Response, error = "Not found.") =>
  sendError(res, 404, error);

export const serverError = (res: Response) =>
  sendError(res, 500, "Something went wrong.");

export const validationError = (res: Response, error: ZodError) =>
  badRequest(res, error.issues[0]?.message ?? "Invalid input.");
