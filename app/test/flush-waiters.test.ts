import { expect, test } from "bun:test";
import { FlushWaiters } from "../src/main/flush-waiters";
import { makeDocumentId, makeRequestId, makeRevisionId } from "../src/shared/types";
test("a different renderer cannot satisfy or delete another window's flush", () => {
  const waiters = new FlushWaiters(); const id = makeRequestId(1);
  const replies: unknown[] = [];
  const response = { documentId: makeDocumentId(3), revisionId: makeRevisionId(0), text: "saved", dirty: false, conflict: false };
  waiters.set(10, id, reply => replies.push(reply));
  waiters.respond(20, id, response); expect(replies).toEqual([]);
  waiters.delete(20, id); waiters.respond(10, id, response); expect(replies).toEqual([response]);
  waiters.delete(10, id); waiters.respond(10, id, response); expect(replies).toHaveLength(1);
});
test("two windows can have the same request sequence without sharing callbacks", () => {
  const waiters = new FlushWaiters(); const id = makeRequestId(1); const seen: number[] = [];
  waiters.set(10, id, () => seen.push(10)); waiters.set(20, id, () => seen.push(20));
  const response = { documentId: makeDocumentId(3), revisionId: makeRevisionId(0), text: "saved", dirty: false, conflict: false };
  waiters.respond(10, id, response); waiters.respond(20, id, response); expect(seen).toEqual([10, 20]);
});
