import "server-only";
import { InsufficientBalanceError, UsageLimitError } from "./billing";
import { FollowCheckError } from "./follow-check";
import { PublishError } from "./publish";
import { XApiError } from "./x";

/** 互关检测接口共用：把能告诉用户的错误转成带说明的回应，其他的照常抛出 */
export function followCheckError(e: unknown): Response {
  if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
  if (e instanceof UsageLimitError) return Response.json({ error: e.message }, { status: 429 });
  if (e instanceof FollowCheckError || e instanceof PublishError || e instanceof XApiError) return Response.json({ error: e.message }, { status: 422 });
  throw e;
}
