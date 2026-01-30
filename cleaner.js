const fs = require('fs');
const path = require('path');

// Buscaremos en la carpeta actual Y en la carpeta data
const SEARCH_PATHS = [__dirname, path.join(__dirname, 'data')];
const OUTPUT_FILE = path.join(__dirname, 'data', 'clientes.csv');

function limpiarContactos() {
    console.log("\n🕵️  Iniciando Búsqueda Universal de Contactos...");

    // Asegurar que exista la carpeta data para el resultado
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
        fs.mkdirSync(path.join(__dirname, 'data'));
    }

    const mapaClientes = new Map();
    let archivosLeidos = 0;

    SEARCH_PATHS.forEach(rutaBusqueda => {
        if (!fs.existsSync(rutaBusqueda)) return;

        const archivos = fs.readdirSync(rutaBusqueda).filter(f => 
            (f.endsWith('.csv') || f.endsWith('.CSV') || f.endsWith('.txt')) && 
            f !== 'clientes.csv'
        );

        archivos.forEach(archivo => {
            const rutaCompleta = path.join(rutaBusqueda, archivo);
            console.log(`📂 Leyendo: ${archivo} (en ${rutaBusqueda})`);
            
            try {
                const contenido = fs.readFileSync(rutaCompleta, 'utf-8');
                
                // EXPRESIÓN REGULAR "CAZADORA" MEJORADA
                // Busca cualquier cosa que parezca un celular chileno:
                // 9 1234 5678, 56912345678, +56 9 1234 5678
                const regex = /(?:\+?56\s?)?(9[\s\d]{8,12})/g;
                
                const matches = contenido.match(regex);

                if (matches) {
                    matches.forEach(raw => {
                        // Limpiar: dejar solo números
                        let numero = raw.replace(/\D/g, '');

                        // Normalizar a 569XXXXXXXX
                        // Si tiene 8 dígitos (ej: 91234567) -> 56991234567
                        if (numero.length === 8) numero = '569' + numero;
                        // Si tiene 9 dígitos y empieza con 9 -> 569...
                        if (numero.length === 9 && numero.startsWith('9')) numero = '56' + numero;
                        
                        // Validar que sea un móvil chileno válido (11 dígitos, empieza con 569)
                        if (numero.length === 11 && numero.startsWith('569')) {
                            // Guardamos (el Map evita duplicados automáticamente)
                            mapaClientes.set(numero, "Apoderado VMA");
                        }
                    });
                    archivosLeidos++;
                }
            } catch (e) {
                console.log(`⚠️  No se pudo leer ${archivo}: ${e.message}`);
            }
        });
    });

    if (mapaClientes.size === 0) {
        console.log("\n❌ NO SE ENCONTRARON CONTACTOS.");
        console.log("   Por favor asegúrate de que tus archivos .csv estén en la carpeta 'Camila VMABE'.");
        return;
    }

    // Guardar resultado final
    let salida = "";
    mapaClientes.forEach((nombre, numero) => {
        salida += `${numero},${nombre}\n`;
    });

    fs.writeFileSync(OUTPUT_FILE, salida);

    console.log("\n========================================");
    console.log(`✅ ¡LISTO! ARCHIVOS PROCESADOS: ${archivosLeidos}`);
    console.log(`✨ Contactos Únicos Recuperados: ${mapaClientes.size}`);
    console.log(`📂 Archivo final creado en: data/clientes.csv`);
    console.log("========================================\n");
}

limpiarContactos();
