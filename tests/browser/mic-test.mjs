// Loopback sound test: record-and-play and live monitoring, before and during a call.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.BASE_URL || "http://localhost:18080", prefix = "mictest-" + Date.now().toString(36);
const checks = [], errors = [];
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
try {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { const Native = window.RTCPeerConnection; window.__rtcPeers = []; window.RTCPeerConnection = class extends Native { constructor(...a) { super(...a); window.__rtcPeers.push(this); } }; });
  const post = async (path, data) => { const r = await ctx.request.post(base + path, data === undefined ? {} : { data }); const b = await r.json(); assert.ok(r.ok(), path + " " + b.error); return b; };
  await post("/api/auth/register", { username: prefix + "a", password: "TestMicTest-123!" });
  await post("/api/communities", { name: prefix });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|data channel .* closed unexpectedly/.test(m.text())) errors.push(m.text()); });
  await page.goto(base);
  await page.locator(".channel").filter({ hasText: "休闲大厅" }).click();
  await page.locator(".audio-settings summary").click();
  const test = page.locator(".mic-test");
  const level = () => page.locator(".mic-meter").getAttribute("data-level").then(Number);
  const waitMode = (mode, timeout = 12000) => page.waitForSelector(`.mic-test[data-mode="${mode}"]`, { timeout });
  async function recordAndPlay(label) {
    await page.getByRole("button", { name: "录音 5 秒并回放" }).click();
    await waitMode("recording");
    await page.waitForFunction(() => Number(document.querySelector(".mic-meter")?.dataset.level) > 0.2, null, { timeout: 5000 });
    await waitMode("playing");
    await page.waitForFunction(() => { const a = document.querySelector(".mic-test-audio"); return a && !a.paused && a.currentTime > 0.5 && a.src.startsWith("blob:"); }, null, { timeout: 8000 });
    await waitMode("idle", 15000);
    checks.push(label);
  }
  await recordAndPlay("Record-and-play works before joining, with a moving level meter");

  await page.getByRole("button", { name: "实时监听" }).click();
  await waitMode("monitoring");
  await page.waitForFunction(() => { const a = document.querySelector(".mic-test-audio"); return a && !a.paused && a.srcObject?.getAudioTracks()[0]?.readyState === "live"; });
  await page.waitForFunction(() => Number(document.querySelector(".mic-meter")?.dataset.level) > 0.2, null, { timeout: 5000 });
  await page.getByRole("button", { name: "停止监听" }).click();
  await waitMode("idle");
  assert.equal(await level(), 0);
  assert.equal(await page.evaluate(() => document.querySelector(".mic-test-audio").srcObject), null);
  checks.push("Live monitoring plays the microphone and stops cleanly");

  await page.getByLabel("降噪").selectOption("gtcrn");
  await page.getByLabel("人声凸显").check();
  await page.getByRole("button", { name: "录音 5 秒并回放" }).click();
  await waitMode("playing", 12000);
  await waitMode("idle", 15000);
  checks.push("Record-and-play runs through AI noise suppression and voice emphasis");
  await page.getByLabel("降噪").selectOption("browser");
  await page.getByLabel("人声凸显").uncheck();

  await page.getByRole("button", { name: "加入语音", exact: true }).click();
  await page.getByRole("button", { name: "关闭麦克风", exact: true }).waitFor({ timeout: 30000 });
  await recordAndPlay("Record-and-play during a call uses the sending track");
  await page.getByRole("button", { name: "离开语音" }).waitFor();
  assert.ok(await page.evaluate(() => (window.__rtcPeers || []).flatMap(p => p.getSenders()).some(s => s.track?.kind === "audio" && s.track.readyState === "live")), "call microphone was stopped by the test");
  checks.push("The call microphone keeps sending after the test");

  await page.getByRole("button", { name: "录音 5 秒并回放" }).click();
  await waitMode("recording");
  await page.getByRole("button", { name: "取消录音" }).click();
  await waitMode("idle");
  checks.push("Recording can be cancelled");
  assert.deepEqual(errors, []);
  const report = { ok: true, prefix, checks, limits: ["Chromium fake microphone and headless audio output; what a person hears is not verified."] };
  fs.writeFileSync("/reports/mic-test.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
