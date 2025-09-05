document.getElementById("run").addEventListener("click", async () => {
    const otp = document.getElementById("otp").value;
    const enemy1 = document.getElementById("enemy1").value;
    const enemy2 = document.getElementById("enemy2").value;
    const enemy3 = document.getElementById("enemy3").value;
    const enemy4 = document.getElementById("enemy4").value;
    const enemy5 = document.getElementById("enemy5").value;
    const enemy = enemy1 + " " + enemy2 + " " + enemy3 + " " + enemy4 + " " + enemy5;

    const result = document.getElementById("result");
    result.textContent = "Czekaj, trwa analiza...";

    try {
        const build = await window.api.runScraper(otp, enemy);

        let tableHTML = `
            <h3>${build.title}</h3>
            <table border="1" cellspacing="0" cellpadding="5">
                <thead>
                    <tr>
                        <th>Slot</th>
                        <th>Item</th>
                        <th>WR</th>
                        <th>PR</th>
                        <th>Games</th>
                        <th>Adj Score</th>
                    </tr>
                </thead>
                <tbody>
        `;

        for (const i of build.items) {
            tableHTML += `
                <tr>
                    <td>${i.slot}</td>
                    <td>${i.item}</td>
                    <td>${i.wr}</td>
                    <td>${i.pr}</td>
                    <td>${i.games}</td>
                    <td>${i.adj}</td>
                </tr>
            `;
        }

        tableHTML += `
                </tbody>
            </table>
        `;

        result.innerHTML = tableHTML;
    } catch (err) {
        result.textContent = "Błąd: " + err.message;
    }
});
