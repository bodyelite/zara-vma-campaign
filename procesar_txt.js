const fs = require('fs');
const path = require('path');

// RUTAS AJUSTADAS: Ahora busca DENTRO de la carpeta data
const INPUT_FILE = path.join(__dirname, 'data', 'CLIENTES.txt');
const OUTPUT_FILE = path.join(__dirname, 'data', 'clientes.csv');

function procesar() {
    console.log(`📍 Buscando archivo en: ${INPUT_FILE}`);

    if (!fs.existsSync(INPUT_FILE)) {
        console.log("❌ ERROR: No encuentro 'CLIENTES.txt' dentro de la carpeta 'data'.");
        return;
    }

    const contenido = fs.readFileSync(INPUT_FILE, 'utf-8');
    
    // EXPRESIÓN REGULAR MAESTRA (Detecta 8 o 9 dígitos)
    const regex = /(?:\+?56\s?|(?<!\d))(\d{8,9})(?!\d)/g;
    
    const mapaClientes = new Map();
    let encontrados = 0;

    const lineas = contenido.split(/\r?\n/);
    
    lineas.forEach(linea => {
        const matches = linea.match(regex);
        
        if (matches) {
            matches.forEach(raw => {
                let numero = raw.replace(/\D/g, ''); 

                // Normalizar
                if (numero.length === 8) numero = '569' + numero;
                if (numero.length === 9 && numero.startsWith('9')) numero = '56' + numero;
                
                // Validar
                if (numero.length === 11 && numero.startsWith('569')) {
                    // Intentar rescatar nombre limpiando la línea
                    let nombre = linea.replace(raw, '').replace(/[^\w\sñÑáéíóúÁÉÍÓÚ]/g, '').trim();
                    if (nombre.length < 2) nombre = "Apoderado VMA";
                    else nombre = nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();

                    mapaClientes.set(numero, nombre);
                    encontrados++;
                }
            });
        }
    });

    // Guardar
    let salida = "";
    mapaClientes.forEach((nombre, numero) => {
        salida += `${numero},${nombre}\n`;
    });

    fs.writeFileSync(OUTPUT_FILE, salida);

    console.log("\n========================================");
    console.log(`✅ ¡LISTO! PROCESADO CORRECTAMENTE`);
    console.log(`📥 Números encontrados: ${encontrados}`);
    console.log(`✨ Contactos Únicos: ${mapaClientes.size}`);
    console.log(`📁 Archivo generado: data/clientes.csv`);
    console.log("========================================\n");
}

procesar();
