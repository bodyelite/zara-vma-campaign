const { chatWithGPT } = require("./services/chatgpt");
const readline = require("readline");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log("\n====================================================");
console.log(" 🧠 MODO DE PRUEBA: CEREBRO DE CAMILA (SIN WHATSAPP)");
console.log("====================================================");
console.log("Escribe como si fueras un cliente. Escribe 'salir' para terminar.\n");

const ask = () => {
    rl.question("Tú (Cliente): ", async (msg) => {
        if (msg.toLowerCase() === "salir") {
            rl.close();
            return;
        }

        // Simulamos un ID de usuario 'test-user' para probar la memoria
        const response = await chatWithGPT(msg, "test-user");
        
        console.log(`\nCamila: ${response}\n`);
        ask();
    });
};

ask();
