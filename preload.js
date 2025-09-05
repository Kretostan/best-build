const { contextBridge, ipcRenderer } = require("electron");

// console.log("Preload loaded");

contextBridge.exposeInMainWorld("api", {
    runScraper: (otp, enemy) =>
        ipcRenderer.invoke("run-scraper", { otp, enemy })
});