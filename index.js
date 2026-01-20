import express from "express";
import { chromium } from "playwright";

const app = express();

app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url required");

  const browser = await chromium.launch({
    args: ["--disable-web-security"]
  });

  const context = await browser.newContext({
    javaScriptEnabled: true,
    bypassCSP: true
  });

  // Service Worker / analytics / beacon 無効化
  await context.route("**/*", route => {
    const type = route.request().resourceType();
    if (["beacon", "websocket"].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  const page = await context.newPage();

  await page.goto(url, { waitUntil: "networkidle" });

  // SPA安定待ち（DOM + fetch 完了）
  await page.waitForFunction(() => {
    return (
      document.readyState === "complete" &&
      performance.getEntriesByType("resource").length > 10
    );
  });

  // 最終保険
  await page.waitForTimeout(1000);

  const html = await page.evaluate(async () => {

    /* ========= script 完全除去 ========= */
    document.querySelectorAll("script").forEach(s => s.remove());

    /* ========= CSP破壊 ========= */
    document
      .querySelectorAll("meta[http-equiv='Content-Security-Policy']")
      .forEach(m => m.remove());

    /* ========= CSS統合 ========= */
    let cssText = "";

    for (const sheet of [...document.styleSheets]) {
      try {
        for (const rule of sheet.cssRules) {
          cssText += rule.cssText + "\n";
        }
      } catch {
        // cross-origin stylesheet
      }
    }

    /* ========= CSS内 url() Base64 ========= */
    cssText = cssText.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, src) => {
      if (src.startsWith("data:")) return m;
      return `url(${new URL(src, location.href).href})`;
    });

    const style = document.createElement("style");
    style.textContent = cssText;
    document.head.appendChild(style);

    document.querySelectorAll("link[rel='stylesheet']").forEach(l => l.remove());

    /* ========= IMG Base64 ========= */
    for (const img of [...document.images]) {
      try {
        const res = await fetch(img.src);
        const blob = await res.blob();

        const reader = new FileReader();
        const dataUrl = await new Promise(r => {
          reader.onload = () => r(reader.result);
          reader.readAsDataURL(blob);
        });

        img.src = dataUrl;
      } catch {}
    }

    /* ========= SVG 内包 ========= */
    document.querySelectorAll("img[src$='.svg']").forEach(async img => {
      try {
        const txt = await (await fetch(img.src)).text();
        const div = document.createElement("div");
        div.innerHTML = txt;
        img.replaceWith(div.firstChild);
      } catch {}
    });

    /* ========= iframe (same-origin) ========= */
    for (const iframe of [...document.querySelectorAll("iframe")]) {
      try {
        const doc = iframe.contentDocument;
        iframe.replaceWith(doc.documentElement.cloneNode(true));
      } catch {}
    }

    return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
  });

  await browser.close();

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.listen(3000, () =>
  console.log("proxy running http://localhost:3000/proxy?url=...")
);
