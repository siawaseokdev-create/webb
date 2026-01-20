import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/*
  ===== Render 安定化用 =====
*/
let running = 0;
const MAX_CONCURRENT = 1; // Renderでは必ず1にする

app.use((req, res, next) => {
  if (running >= MAX_CONCURRENT) {
    return res.status(429).send("Server busy");
  }
  running++;
  res.on("finish", () => running--);
  next();
});

/*
  ===== メイン =====
*/
app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url required");

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process"
      ]
    });

    const context = await browser.newContext({
      javaScriptEnabled: true,
      bypassCSP: true
    });

    // Service Worker / analytics / 無駄通信を遮断
    await context.route("**/*", route => {
      const type = route.request().resourceType();
      if (
        type === "beacon" ||
        type === "websocket" ||
        type === "eventsource"
      ) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 30000
    });

    // SPA 安定待ち
    await page.waitForFunction(() => {
      return (
        document.readyState === "complete" &&
        document.body &&
        document.body.innerHTML.length > 1000
      );
    }, { timeout: 15000 });

    // 保険
    await page.waitForTimeout(1000);

    const html = await page.evaluate(async () => {

      /* ===== script 完全削除 ===== */
      document.querySelectorAll("script").forEach(s => s.remove());

      /* ===== CSP 無効化 ===== */
      document
        .querySelectorAll("meta[http-equiv='Content-Security-Policy']")
        .forEach(m => m.remove());

      /* ===== CSS 統合 ===== */
      let cssText = "";

      for (const sheet of [...document.styleSheets]) {
        try {
          for (const rule of sheet.cssRules) {
            cssText += rule.cssText + "\n";
          }
        } catch {
          // cross-origin は無視
        }
      }

      const style = document.createElement("style");
      style.textContent = cssText;
      document.head.appendChild(style);

      document
        .querySelectorAll("link[rel='stylesheet']")
        .forEach(l => l.remove());

      /* ===== 画像 Base64 ===== */
      for (const img of [...document.images]) {
        try {
          const r = await fetch(img.src);
          const b = await r.blob();
          const reader = new FileReader();

          const dataUrl = await new Promise(resolve => {
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(b);
          });

          img.src = dataUrl;
        } catch {}
      }

      /* ===== SVG 内包 ===== */
      const svgImgs = [...document.querySelectorAll("img[src$='.svg']")];
      for (const img of svgImgs) {
        try {
          const txt = await (await fetch(img.src)).text();
          const div = document.createElement("div");
          div.innerHTML = txt;
          img.replaceWith(div.firstChild);
        } catch {}
      }

      /* ===== iframe（same-origin） ===== */
      for (const iframe of [...document.querySelectorAll("iframe")]) {
        try {
          const doc = iframe.contentDocument;
          if (doc) {
            iframe.replaceWith(doc.documentElement.cloneNode(true));
          }
        } catch {}
      }

      return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
    });

    await browser.close();

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);

  } catch (err) {
    if (browser) await browser.close();
    res.status(500).send("snapshot failed");
  }
});

/*
  ===== Render ヘルスチェック =====
*/
app.get("/", (_, res) => {
  res.send("OK");
});

app.listen(PORT, () => {
  console.log(`Render proxy running on ${PORT}`);
});
