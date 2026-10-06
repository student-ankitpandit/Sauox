import http from "http";
import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:3000";
const PORT = 9223;
const clients = new Set();
let lastFrame = null; // screencast only emits on visual change, so keep the latest for new viewers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (res, jpeg) => {
    res.write(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    );
    res.write(jpeg);
    res.write("\r\n");
};

(async () => {
    // wait for the dev server the agent started
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(TARGET);
        break;
        } catch {
            await sleep(1000);
        }
    }

    const browser = await chromium.launch();
    const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
    });
    await page.goto(TARGET).catch(() => {});

    const cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
        lastFrame = Buffer.from(data, "base64");
        for (const res of clients) write(res, lastFrame);
        await cdp.send("Page.screencastFrameAck", { sessionId }); // required, or Chrome stops sending
    });
    await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        everyNthFrame: 2,
    });

    http
        .createServer((req, res) => {
        res.writeHead(200, {
            "Content-Type": "multipart/x-mixed-replace; boundary=frame",
            "Cache-Control": "no-cache",
        });
        if (lastFrame) write(res, lastFrame);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        })
        .listen(PORT, "0.0.0.0");
    })();
