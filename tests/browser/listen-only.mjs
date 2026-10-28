// Microphone denial keeps a listen-only voice connection; owners can remove members from the UI.
import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.BASE_URL || "http://localhost:18080", prefix = "listen-test-" + Date.now().toString(36);
const errors = [], checks = [];
// No --use-fake-ui-for-media-stream: the permission request is denied, as when a user blocks the microphone.
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream"] });
try {
  const owner = await browser.newContext(), guest = await browser.newContext();
  const post = async (ctx, path, data) => { const r = await ctx.request.post(base + path, data === undefined ? {} : { data }); const b = await r.json(); assert.ok(r.ok(), path + " " + r.status() + " " + b.error); return b; };
  await post(owner, "/api/auth/register", { username: prefix + "a", password: "TestListen-123!" });
  const guestUser = (await post(guest, "/api/auth/register", { username: prefix + "b", password: "TestListen-123!" })).user;
  const { community } = await post(owner, "/api/communities", { name: prefix });
  const inv = await post(owner, "/api/communities/" + community.id + "/invites");
  await post(guest, "/api/invites/" + inv.code + "/join");
  const page = await owner.newPage();
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(base);
  await page.locator(".channel").filter({ hasText: "休闲大厅" }).click();
  await page.getByRole("button", { name: "加入语音", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "仅收听" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "离开语音" }).waitFor();
  await page.getByText("已连接", { exact: false }).first().waitFor();
  checks.push("Denied microphone joins listen-only instead of disconnecting");
  await page.getByRole("button", { name: "离开语音" }).click();
  page.on("dialog", d => d.accept());
  await page.getByRole("button", { name: "移出" + guestUser.username }).click();
  await page.locator(".member").filter({ hasText: guestUser.username }).waitFor({ state: "detached" });
  const r = await guest.request.get(base + "/api/communities/" + community.id);
  assert.equal(r.status(), 403);
  checks.push("Owner removes a member from the members panel");
  await page.getByRole("button", { name: "删除社区" }).click();
  await page.getByText("还没有社区").first().waitFor();
  checks.push("Owner deletes the community from the members panel");
  // 401 from an expired session returns to the login screen.
  await owner.clearCookies();
  await page.reload();
  await page.getByRole("button", { name: "进入小屋" }).waitFor();
  checks.push("Missing session shows the login screen");
  // Deleting the community deletes its LiveKit room; the SDK then logs its data channels closing.
  const cspOrUnexpected = errors.filter(e => !/401|403|Failed to load resource|data channel .* closed unexpectedly/.test(e));
  assert.deepEqual(cspOrUnexpected, []);
  console.log(JSON.stringify({ ok: true, prefix, checks }, null, 2));
} finally { await browser.close(); }
