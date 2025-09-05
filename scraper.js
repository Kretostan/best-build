// scraper.js  (Node.js ESM)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { Command } from "commander";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- stałe
const PATCH = "30";
const URL_TPL = (otp, enemy) => `https://lolalytics.com/lol/${otp}/vs/${enemy}/build/?patch=${PATCH}`;

const build = {
    title: "",
    items: []
};

const SECTION_META = {
    item1: { left: "Item 1", slot: "first", suffix: "item1", pretty: "Item 1", top: 4 },
    boots: { left: "Boots", slot: "boots", suffix: "boots", pretty: "Boots", top: 4 },
    item2: { left: "Item 2", slot: "second", suffix: "item2", pretty: "Item 2", top: 4 },
    item3: { left: "Item 3", slot: "third", suffix: "item3", pretty: "Item 3", top: 4 },
    item4: { left: "Item 4", slot: "fourth", suffix: "item4", pretty: "Item 4", top: 4 },
    item5: { left: "Item 5", slot: "fifth", suffix: "item5", pretty: "Item 5", top: 4 },
};

const BLOCKED_DOMAINS = [
    "googletagmanager.com", "google-analytics.com", "doubleclick.net",
    "facebook.net", "hotjar.com", "segment.io", "amplitude.com",
    "mixpanel.com", "sentry.io", "intercomcdn.com", "clarity.ms",
];

// --- utils
function slug(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function toFloat(txt) {
    if (!txt) return 0.0;
    let s = txt.replace(/\u00a0/g, " ").replace(/%/g, "");
    s = s.replace(/[^0-9.,]/g, "").replace(",", ".");
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0.0;
}
function fmtPct(v, d = 2) {
    return `${(Number(v) || 0).toFixed(d)}%`;
}
function fmtNum(v) {
    return `${Math.round(Number(v) || 0)}`;
}
function writeCSV(filePath, rows, columns) {
    const esc = (x) => {
        const s = String(x ?? "");
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const header = columns.join(",");
    const body = rows.map(r => columns.map(c => esc(r[c])).join(",")).join("\n");
    fs.writeFileSync(filePath, header + "\n" + body, "utf8");
}

// --- routing / request blocking
async function installRoutes(context) {
    await context.route("**/*", async (route, request) => {
        const rt = request.resourceType();
        const url = request.url();
        if (["image", "media", "font"].includes(rt)) return route.abort();
        if (BLOCKED_DOMAINS.some(d => url.includes(d))) return route.abort();
        return route.continue();
    });
}

// --- kontekst
async function openCtx({ persistent = false, userDataDir = "user-data" } = {}) {
    const args = [
        "--disable-gpu",
        "--disable-extensions",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-features=IsolateOrigins,site-per-process",
    ];
    let browser, ctx;
    if (persistent) {
        ctx = await chromium.launchPersistentContext(path.join(__dirname, userDataDir), {
            headless: true,
            args,
            locale: "pl-PL",
            timezoneId: "Europe/Warsaw",
            viewport: { width: 1400, height: 950 },
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        });
        await installRoutes(ctx);
        ctx.setDefaultTimeout(20000);
        return { browser: ctx, ctx, isPersistent: true };
    } else {
        browser = await chromium.launch({ headless: true, args });
        ctx = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale: "pl-PL",
            timezoneId: "Europe/Warsaw",
            viewport: { width: 1400, height: 950 },
        });
        await installRoutes(ctx);
        ctx.setDefaultTimeout(20000);
        return { browser, ctx, isPersistent: false };
    }
}

// --- cookies
async function acceptCookiesOnce(page) {
    try {
        await page.waitForTimeout(400);
        const labels = ["Accept", "Agree", "Akcept", "Zgadzam"];
        for (const name of labels) {
            const btn = page.getByRole("button", { name, exact: false });
            if ((await btn.count()) > 0) {
                try { await btn.first().click({ timeout: 1200 }); break; } catch {}
            }
        }
    } catch {}
}

// --- znajdź slider
async function findSlider(page, sectionKey) {
    const meta = SECTION_META[sectionKey];
    let leftXPath;
    if (meta.left.toLowerCase() === "boots") {
        leftXPath = "//div[contains(@class,'w-[80px]')][.//div[normalize-space()='Boots']]";
    } else {
        const m = meta.left.match(/(\d+)/);
        const n = m ? m[1] : "";
        leftXPath = `//div[contains(@class,'w-[80px]')][.//div[normalize-space()='Item'] and .//div[normalize-space()='${n}']]`;
    }
    const sliderXPath = leftXPath + "/following-sibling::div[contains(@class,'cursor-grab')][1]";
    const sld = page.locator(`xpath=${sliderXPath}`).first();
    await sld.waitFor({ state: "attached", timeout: 20000 });
    try { await sld.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
    await sld.locator("xpath=.//img[@alt]").first().waitFor({ state: "attached", timeout: 20000 });
    return sld;
}

// --- wyciąganie kart ze slidera
async function extractRowsFromSlider(slider) {
    const container = slider
        .locator("xpath=.//div[contains(@class,'flex') and contains(@class,'text-center')]")
        .first();
    await container.waitFor({ state: "attached", timeout: 20000 });

    const rows = [];
    const seen = new Set();
    try { await slider.evaluate(el => (el.scrollLeft = 0)); } catch {}

    let noNewSteps = 0;
    let prevSeenCount = 0;
    let prevLeft = await slider.evaluate(el => el.scrollLeft);

    for (let step = 0; step < 200; step++) {
        const cards = container.locator("xpath=./div[span[img[@alt]]]");
        const cnt = await cards.count();

        for (let i = 0; i < cnt; i++) {
            const card = cards.nth(i);
            let name = "";
            try {
                name =
                    (await card
                        .locator("xpath=.//span[img[@alt]][1]/img[@alt]")
                        .first()
                        .getAttribute("alt"))?.trim() || "";
            } catch {}
            if (!name || seen.has(name)) continue;

            let wrTxt = "", prTxt = "", gmTxt = "";
            try {
                const span = card.locator("xpath=.//span[img[@alt]][1]");
                wrTxt = await span.locator("xpath=following-sibling::div[1]").innerText({ timeout: 700 });
                prTxt = await span.locator("xpath=following-sibling::div[2]").innerText({ timeout: 700 });
                gmTxt = await span.locator("xpath=following-sibling::div[3]").innerText({ timeout: 700 });
            } catch {
                try {
                    const base = card.locator("xpath=.//img[@alt]/ancestor::div[1]");
                    wrTxt = await base.locator("xpath=following-sibling::div[1]").innerText({ timeout: 700 });
                    prTxt = await base.locator("xpath=following-sibling::div[2]").innerText({ timeout: 700 });
                    gmTxt = await base.locator("xpath=following-sibling::div[3]").innerText({ timeout: 700 });
                } catch { continue; }
            }

            const wr = toFloat(wrTxt);
            const pr = toFloat(prTxt);
            const gm = Math.round(toFloat(gmTxt));
            rows.push({ item: name, win_rate: wr, pick_rate: pr, games: gm });
            seen.add(name);
        }

        if (seen.size === prevSeenCount) noNewSteps++;
        else { noNewSteps = 0; prevSeenCount = seen.size; }

        try {
            prevLeft = await slider.evaluate(el => el.scrollLeft);
            await slider.evaluate(
                el => (el.scrollLeft = Math.min(el.scrollLeft + Math.floor(el.clientWidth * 1.5), el.scrollWidth))
            );
            await slider.page().waitForTimeout(60);
            const newLeft = await slider.evaluate(el => el.scrollLeft);
            if (noNewSteps >= 4 && newLeft === prevLeft) break;
        } catch {}
    }
    return rows;
}

// --- agregacja wielu przeciwników
function aggregateRows(listOfRows) {
    const acc = new Map(); // name -> { games, wr_weighted_sum }
    for (const rows of listOfRows) {
        for (const r of rows) {
            const name = r.item;
            const g = Math.round(r?.games || 0);
            const wr = Number(r?.win_rate || 0);
            if (g <= 0) continue;
            if (!acc.has(name)) acc.set(name, { games: 0, wr_weighted_sum: 0 });
            const o = acc.get(name);
            o.games += g;
            o.wr_weighted_sum += wr * g;
        }
    }
    const total_games = [...acc.values()].reduce((s, v) => s + v.games, 0);
    const out = [];
    for (const [name, v] of acc.entries()) {
        const g = v.games;
        const wr = g > 0 ? v.wr_weighted_sum / g : 0;
        const pr = total_games > 0 ? (100 * g) / total_games : 0;
        out.push({ item: name, win_rate: wr, pick_rate: pr, games: g });
    }
    return out;
}

async function collectRowsForSection(page, section_key) {
    const sld = await findSlider(page, section_key);
    return extractRowsFromSlider(sld);
}

// --- filtr + EB shrinkage + sort
function scoreAndFilter(rows) {
    const total_games = rows.reduce((s, r) => s + (r.games || 0), 0);
    const hard = total_games ? Math.max(Math.trunc(0.01 * total_games), 30) : 30;
    const prior_m = total_games ? Math.min(Math.trunc(0.1 * total_games), 300) : 0;

    let top = [];
    if (total_games > 0) {
        const mu = rows.reduce((s, r) => s + (r.win_rate || 0) * (r.games || 0), 0) / Math.max(total_games, 1);
        const kept = [];
        for (const r of rows) {
            const g = Math.round(r.games || 0);
            if (g < hard) continue;
            const wr = Number(r.win_rate || 0);
            const wr_eb = (wr * g + mu * prior_m) / (g + prior_m);
            const share = (100 * g) / total_games;
            kept.push({
                ...r,
                wr_eb: +wr_eb.toFixed(4),
                share: +share.toFixed(2),
                score: +wr_eb.toFixed(4),
            });
        }
        if (kept.length === 0) {
            const soft_min = Math.max(Math.trunc(0.005 * total_games), 15);
            const den = rows.filter(r => (r.games || 0) >= soft_min).reduce((s, r) => s + (r.games || 0), 0) || 1;
            const mu_soft =
                rows
                    .filter(r => (r.games || 0) >= soft_min)
                    .reduce((s, r) => s + (r.win_rate || 0) * (r.games || 0), 0) / den;

            const soft = [];
            for (const r of rows) {
                const g = Math.round(r.games || 0);
                if (g < soft_min) continue;
                const wr = Number(r.win_rate || 0);
                const wr_eb = (wr * g + mu_soft * prior_m) / (g + prior_m);
                const share = (100 * g) / total_games;
                soft.push({
                    ...r,
                    wr_eb: +wr_eb.toFixed(4),
                    share: +share.toFixed(2),
                    score: +wr_eb.toFixed(4),
                });
            }
            soft.sort((a, b) => b.score - a.score);
            top = soft;
        } else {
            kept.sort((a, b) => b.score - a.score);
            top = kept;
        }
    } else {
        const rows2 = rows.map(r => ({
            ...r,
            wr_eb: r.win_rate,
            share: 0.0,
            score: r.win_rate,
        }));
        rows2.sort((a, b) => (b.pick_rate - a.pick_rate) || (b.win_rate - a.win_rate));
        top = rows2;
    }
    return { df_out: top, total_games, hard, prior_m };
}

// --- wybór najlepszego itemu dla slotu
function pickBestForSlot(df_numeric, alreadyPicked, beta = 0.25, min_pr = 4.0) {
    if (!df_numeric || df_numeric.length === 0) return null;
    const df = df_numeric.filter(r => !alreadyPicked.has(r.item)).filter(r => (r.pick_rate || 0) >= min_pr);
    if (df.length === 0) return null;

    const withAdj = df.map(r => ({
        ...r,
        adj_score: (r.wr_eb || 0) + beta * Math.sqrt(r.pick_rate || 0),
    }));
    withAdj.sort((a, b) => (b.adj_score - a.adj_score) || (b.wr_eb - a.wr_eb) || (b.games - a.games));

    let top = { ...withAdj[0] };
    if (withAdj.length >= 2) {
        const second = withAdj[1];
        if ((top.adj_score - second.adj_score) < 0.05 && (second.games || 0) > (top.games || 0)) {
            top = { ...second };
        }
    }
    return {
        item: top.item,
        wr_eb: Number(top.wr_eb || 0),
        pick_rate: Number(top.pick_rate || 0),
        games: Math.round(top.games || 0),
        adj_score: Number(top.adj_score || 0),
    };
}

// --- scrape jednego przeciwnika
async function scrapeEnemy(ctx, otp_clean, enemy, sections) {
    const otp_s = slug(otp_clean), enemy_s = slug(enemy);
    const url = URL_TPL(otp_s, enemy_s);
    const page = await ctx.newPage();
    // console.log(`Scraping: ${otp_clean} vs ${enemy}  →  ${url}`);
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await acceptCookiesOnce(page);
        const per_section = {};
        for (const sec of sections) {
            try {
                per_section[sec] = await collectRowsForSection(page, sec);
            } catch {
                per_section[sec] = [];
            }
        }
        return [enemy, per_section];
    } finally {
        await page.close();
    }
}

// --- główne
async function main() {
    const program = new Command();
    program
        .description("LoLalytics – Item 1 / Boots / Item 2–5 (patch=30, 1–5 przeciwników, async równolegle).")
        .requiredOption("--otp <name>")
        .option("--enemy <name>", "Pojedynczy przeciwnik (zgodność wsteczna).")
        .option("--enemies <names...>", "Lista 1–5 przeciwników (spacja lub przecinki).")
        .option("--section <key>", "item1|boots|item2|item3|item4|item5|all", "all")
        .option("--beta <num>", "Waga popularności w doborze buildu (domyślnie 0.25).", v => parseFloat(v), 0.25)
        .option("--persistent", "Użyj persistent context.", false);

    program.parse(process.argv);
    const args = program.opts();

    let enemies_raw = [];
    if (args.enemies) enemies_raw.push(...args.enemies);
    if (args.enemy) enemies_raw.push(args.enemy);
    if (enemies_raw.length === 0) {
        console.error("Podaj co najmniej jednego przeciwnika: --enemy X lub --enemies X Y ...");
        process.exit(1);
    }
    let enemies = enemies_raw.flatMap(t => t.split(/[,\s]+/).filter(Boolean)).slice(0, 5);

    const sections = args.section !== "all"
        ? [args.section]
        : ["item1","boots","item2","item3","item4","item5"];
    const otp_clean = String(args.otp || "").trim();

    const all_tables = [];
    const raw_numeric_by_section = {};

    const { browser, ctx, isPersistent } = await openCtx({ persistent: !!args.persistent });
    try {
        // równolegle: 1 enemy = 1 page
        const tasks = enemies.map(enemy => scrapeEnemy(ctx, otp_clean, enemy, sections));
        const results = await Promise.all(tasks);

        // mapujemy: sekcja -> [listy wierszy z każdego enemy]
        const raw_by_section = {};
        for (const sec of sections) raw_by_section[sec] = [];
        for (const [enemy, per_section] of results) {
            for (const sec of sections) raw_by_section[sec].push(per_section[sec] || []);
        }

        // agregacja, filtr, TOP i zapis CSV łączonych wyników
        const out_dir = path.join(__dirname, "out");
        fs.mkdirSync(out_dir, { recursive: true });
        const otp_s = slug(otp_clean);
        const enemies_slug = enemies.map(slug).join("_");

        for (const sec of sections) {
            const meta = SECTION_META[sec];
            const agg_rows = aggregateRows(raw_by_section[sec]);
            const { df_out, total_games, hard, prior_m } = scoreAndFilter(agg_rows);
            raw_numeric_by_section[sec] = df_out.map(r => ({ ...r })); // kopia

            const N = meta.top;
            const df_top = df_out.slice(0, N);
            const csv_path = path.join(out_dir, `${otp_s}_vs_${enemies_slug}_${meta.suffix}.csv`);
            writeCSV(csv_path, df_top, ["item","win_rate","pick_rate","games","wr_eb","share","score"]);

            if (df_top.length) {
                const rows = df_top.map((r, idx) => ({
                    slot: idx === 0 ? meta.slot : "",
                    Item: r.item,
                    "SCORE": (Number(r.score) || 0).toFixed(3),
                    "WR (%)": fmtPct(r.win_rate),
                    "PR (%)": fmtPct(r.pick_rate),
                    "Gry": fmtNum(r.games),
                    "UDZ (%)": fmtPct(r.share),
                    "WR_EB (%)": fmtPct(r.wr_eb),
                }));
                all_tables.push(...rows);
            } else {
                all_tables.push({
                    slot: meta.slot + " (brak po filtrze)",
                    Item: "", SCORE: "", "WR (%)":"", "PR (%)":"", "Gry":"",
                    "UDZ (%)":"", "WR_EB (%)":""
                });
            }
        }
    } finally {
        await ctx.close();
        if (!isPersistent) await browser.close();
    }

    // --- wydruk TOP tabel
    // console.log("\nTOP — Item 1 / Boots / Item 2–5 (agregacja 1–5 przeciwników, po filtrze i EB):");
    // ładny prosty wydruk kolumn
    const cols = ["slot","Item","SCORE","WR (%)","PR (%)","Gry","UDZ (%)","WR_EB (%)"];
    const widths = Object.fromEntries(cols.map(c => [c, Math.max(c.length, ...all_tables.map(r => String(r[c] ?? "").length))]));
    const line = cols.map(c => c.padEnd(widths[c])).join("  ");
    // console.log(line);
    // console.log(cols.map(c => "-".repeat(widths[c])).join("  "));
    for (const r of all_tables) {
        // console.log(cols.map(c => String(r[c] ?? "").padEnd(widths[c])).join("  "));
    }

    // --- OPTYMALNY BUILD
    const order = ["item1", "boots", "item2", "item3", "item4", "item5"];
    const picked = new Set();
    const chosen = [];
    for (const sec of order) {
        const best = pickBestForSlot(raw_numeric_by_section[sec], picked, Number(args.beta) || 0.25);
        if (best) {
            picked.add(best.item);
            chosen.push([sec, best]);
        }
    }
    const slot_pretty = Object.fromEntries(Object.entries(SECTION_META).map(([k,v]) => [k, v.pretty]));

    // console.log(`\nOPTYMALNY BUILD (wybór sekwencyjny z premią za popularność, beta=${Number(args.beta).toFixed(2)}):`);
    build.title = `\nOPTYMALNY BUILD (wybór sekwencyjny z premią za popularność, beta=${Number(args.beta).toFixed(2)}):`
    // for (const [sec, b] of chosen) {
        // console.log(`- ${slot_pretty[sec]}: ${b.item}  |  WR_EB=${b.wr_eb.toFixed(2)}%  |  PR=${b.pick_rate.toFixed(2)}%  |  Games=${b.games}  |  adj=${b.adj_score.toFixed(3)}`);
        // build.items.push(`- ${slot_pretty[sec]}: ${b.item}  |  WR_EB=${b.wr_eb.toFixed(2)}%  |  PR=${b.pick_rate.toFixed(2)}%  |  Games=${b.games}  |  adj=${b.adj_score.toFixed(3)}`);
    // }
    for (const [sec, b] of chosen) {
        build.items.push({
            slot: slot_pretty[sec],
            item: b.item,
            wr: b.wr_eb.toFixed(2) + "%",
            pr: b.pick_rate.toFixed(2) + "%",
            games: b.games,
            adj: b.adj_score.toFixed(3)
        });
    }
    console.log(JSON.stringify(build));
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});