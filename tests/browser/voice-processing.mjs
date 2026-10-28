// AI noise suppression, voice emphasis and device pickers in a real two-member LiveKit call.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.BASE_URL || "http://localhost:18080", prefix = "voicefx-test-" + Date.now().toString(36);
const checks = [], errors = [];
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const contexts = [];
const post = async (ctx, path, data) => { const r = await ctx.request.post(base + path, data === undefined ? {} : { data }); const b = await r.json(); assert.ok(r.ok(), path + " " + r.status() + " " + b.error); return b; };
// The processed track comes from a MediaStreamAudioDestinationNode, whose Chrome deviceId starts with WebAudio-.
async function waitSender(page, processed) {
  await page.waitForFunction(want => (window.__rtcPeers || []).flatMap(p => p.getSenders()).some(s => s.track?.kind === "audio" && s.track.readyState === "live" && String(s.track.getSettings().deviceId).startsWith("WebAudio-") === want), processed, { timeout: 15000 });
}
async function inbound(page) {
  return page.evaluate(async () => { let bytes = 0, packets = 0; for (const p of window.__rtcPeers || []) for (const r of (await p.getStats()).values()) if (r.type === "inbound-rtp" && r.kind === "audio") { bytes += r.bytesReceived; packets += r.packetsReceived; } return { bytes, packets }; });
}
// The Chromium fake microphone is a steady beep, which the AI denoisers remove as noise; with Opus DTX that leaves
// only sparse comfort-noise packets. So AI modes must keep packets arriving, other modes must carry real audio.
async function audioFlows(listener, aiSuppressed = false) {
  const a = await inbound(listener); await listener.waitForTimeout(2000); const b = await inbound(listener);
  if (aiSuppressed) assert.ok(b.packets > a.packets, "no audio packets reaching listener");
  else assert.ok(b.bytes - a.bytes > 2000, "audio not flowing to listener: " + (b.bytes - a.bytes) + " bytes");
}
try {
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 900 } });
    contexts.push(ctx);
    await ctx.addInitScript(() => { const Native = window.RTCPeerConnection; window.__rtcPeers = []; window.RTCPeerConnection = class extends Native { constructor(...a) { super(...a); window.__rtcPeers.push(this); } }; });
    await post(ctx, "/api/auth/register", { username: prefix + (i ? "b" : "a"), password: "TestVoiceFx-123!" });
  }
  const { community } = await post(contexts[0], "/api/communities", { name: prefix });
  const inv = await post(contexts[0], "/api/communities/" + community.id + "/invites");
  await post(contexts[1], "/api/invites/" + inv.code + "/join");
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const page of pages) {
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|data channel .* closed unexpectedly/.test(m.text())) errors.push(m.text()); });
    await page.goto(base);
    await page.locator(".channel").filter({ hasText: "休闲大厅" }).click();
  }
  const [a, b] = pages;
  // Preferences chosen before joining are used on join.
  await a.locator(".audio-settings summary").click();
  await a.getByLabel("降噪").selectOption("rnnoise");
  for (const p of pages) { await p.getByRole("button", { name: "加入语音", exact: true }).click(); await p.getByRole("button", { name: "关闭麦克风", exact: true }).waitFor({ timeout: 30000 }); }
  await b.getByText("频道中 2 人", { exact: false }).waitFor();
  await waitSender(a, true);
  await audioFlows(b, true);
  checks.push("RNNoise chosen before joining processes the published microphone");
  await a.getByLabel("降噪").selectOption("gtcrn"); await waitSender(a, true); await audioFlows(b, true);
  checks.push("GTCRN replaces RNNoise during the call without interrupting audio");
  await a.getByLabel("人声凸显").check(); await a.waitForTimeout(500); await waitSender(a, true); await audioFlows(b, true);
  checks.push("Voice emphasis chain runs together with AI noise suppression");
  await a.getByLabel("降噪").selectOption("browser"); await a.waitForTimeout(800); await waitSender(a, true); await audioFlows(b);
  await a.getByLabel("人声凸显").uncheck(); await waitSender(a, false); await audioFlows(b);
  checks.push("Browser noise suppression recaptures the mic; turning emphasis off restores the raw track");
  await a.getByLabel("降噪").selectOption("gtcrn"); await waitSender(a, true);
  await a.getByLabel("麦克风音质").selectOption("max");
  await a.waitForFunction(() => ![...document.querySelectorAll(".media-quality select")].some(s => s.disabled));
  await waitSender(a, false); await audioFlows(b);
  await a.getByText("当前为立体声音乐档位，降噪与人声凸显不生效。").waitFor();
  await a.getByLabel("麦克风音质").selectOption("standard");
  await a.waitForFunction(() => ![...document.querySelectorAll(".media-quality select")].some(s => s.disabled));
  await waitSender(a, true); await audioFlows(b, true);
  checks.push("Stereo music profiles bypass processing and it returns on mono profiles");
  // Devices: labels appear after permission; switching keeps audio flowing.
  const inputs = await a.getByLabel("麦克风设备").locator("option").allTextContents();
  assert.ok(inputs.length >= 2, "no microphones listed: " + inputs);
  const firstInput = await a.getByLabel("麦克风设备").locator("option").nth(1).getAttribute("value");
  await a.getByLabel("麦克风设备").selectOption(firstInput); await a.waitForTimeout(1000); await waitSender(a, true); await audioFlows(b, true);
  assert.equal(await a.evaluate(() => localStorage.getItem("voice-hub.audio-input")), firstInput);
  checks.push("Microphone picker lists devices and switches input while processed");
  await b.locator(".audio-settings summary").click();
  const outputLabel = b.getByLabel("扬声器设备");
  if (await outputLabel.count()) {
    const outs = await outputLabel.locator("option").evaluateAll(o => o.map(x => x.value));
    if (outs.length > 1) { await outputLabel.selectOption(outs[1]); await b.waitForTimeout(800); assert.equal(await b.evaluate(() => document.querySelector(".audio-host audio")?.sinkId), outs[1]); }
    checks.push("Speaker picker present" + (outs.length > 1 ? " and routes remote audio" : " (no extra output devices in headless Chromium)"));
  }
  await a.reload(); await a.locator(".channel").filter({ hasText: "休闲大厅" }).click(); await a.locator(".audio-settings summary").click();
  assert.equal(await a.getByLabel("降噪").inputValue(), "gtcrn");
  assert.equal(await a.getByLabel("人声凸显").isChecked(), false);
  checks.push("Noise and emphasis preferences persist after reload");
  assert.deepEqual(errors, []);
  const report = { ok: true, prefix, checks, limits: ["Chromium fake microphone is a steady tone that AI suppression removes; perceptual speech quality not measured.", "Headless Chromium usually exposes no extra speaker devices."] };
  fs.writeFileSync("/reports/voice-processing.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
