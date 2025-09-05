import { app, BrowserWindow, ipcMain } from "electron";
import { exec } from 'child_process';
import { dirname } from 'node:path';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlFile = path.join(__dirname, 'index.html')

ipcMain.handle("run-scraper", async (event, { otp, enemy }) => {
    return new Promise((resolve, reject) => {
        const cmd = `node scraper.js --otp ${otp} --enemies ${enemy}`;
        exec(cmd, (err, stdout, stderr) => {
            if (err) return reject(err);

            try {
                const build = JSON.parse(stdout);
                resolve(build);
            } catch (parseError) {
                reject(new Error("Nie udało się sparsować JSON: " + parseError.message));
            }
        });
    });
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: `${__dirname}/preload.js`,
            contextIsolation: true,
        },
    });

    win.loadFile(htmlFile);
}

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

app.whenReady().then(() => {
    createWindow();
});
