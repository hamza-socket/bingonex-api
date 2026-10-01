import assert from "node:assert/strict";
import test from "node:test";
import { hashRefreshToken, issueRefreshToken, issueToken } from "../src/lib/auth.ts";
import { chooseQueueOpponent } from "../src/lib/matchmaking.ts";

test("issueToken fails closed when JWT_SECRET is missing", () => {
  assert.throws(() => issueToken({}, "user-123"), /JWT_SECRET/);
});

test("issueRefreshToken creates a stable opaque token hash", async () => {
  const raw = issueRefreshToken();
  const hashA = await hashRefreshToken(raw);
  const hashB = await hashRefreshToken(raw);

  assert.match(raw, /^refresh_[A-Za-z0-9_-]+$/);
  assert.equal(hashA, hashB);
  assert.notEqual(raw, hashA);
});

test("chooseQueueOpponent picks the oldest valid queue entry", () => {
  const queue = [
    { userId: "z", createdAt: 200, card: [1, 2, 3] },
    { userId: "b", createdAt: 90, card: [1, 2, 3] },
    { userId: "a", createdAt: 50, card: [1, 2, 3] },
  ];

  assert.deepEqual(chooseQueueOpponent(queue, "z"), {
    userId: "a",
    createdAt: 50,
    card: [1, 2, 3],
  });
  assert.deepEqual(chooseQueueOpponent(queue, "a"), {
    userId: "b",
    createdAt: 90,
    card: [1, 2, 3],
  });
});
