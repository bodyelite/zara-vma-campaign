const { chatWithGPT } = require("./services/chatgpt");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("\n===========================================");
console.log("🤖 SIMULADOR CAMILA VMA (Modo Terminal)");
console.log("===========================================");
console.log("Escribe 'salir' para terminar.\n");

// Mensaje inicial falso para arrancar
console.log("Camila: Hola, soy Camila de VMA. Te escribo para ayudarte con el stock escolar 2026. ¿En qué te ayudo?");

const preguntar = () => {
    rl.question("\nTú: ", async (msg) => {
        if (msg.toLowerCase() === "salir") return rl.close();
        
        process.stdout.write("Camila escribiendo... ⏳\r");
        const respuesta = await chatWithGPT(msg, "usuario_prueba");
        
        console.log(`\rCamila: ${respuesta}    `); // Espacios para limpiar el icono de carga
        preguntar();
    });
};

preguntar();
